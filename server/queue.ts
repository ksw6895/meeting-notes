import fs from "node:fs";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { db } from "./db.ts";
import { resolveAudioPath } from "./audio.ts";
import { getSecret } from "./secrets.ts";
import { dedupeOverlap, id, now } from "./utils.ts";

import {
  BudgetExceededError,
  releaseUsage,
  reserveUsage,
  settleUsage,
  settleUsageAtReservation,
  type UsageReservation
} from "./billing.ts";
import { STT_MODEL, transcribeAudio, transcriptionCost } from "./stt.ts";

export const MAX_CHUNK_ATTEMPTS = 5;
const QUEUE_INTERVAL_MS = 1_500;

let timer: NodeJS.Timeout | undefined;
let workerStarted = false;
let inFlight: Promise<void> | undefined;
let chunkController: AbortController | undefined;

class TerminalChunkError extends Error {
  constructor(message: string, readonly billed = false) {
    super(message);
    this.name = "TerminalChunkError";
  }
}

function nextChunk(lectureId?: string): any | undefined {
  return db.prepare(`
    SELECT c.*, l.event_id, l.title AS lecture_title, l.topic AS lecture_topic, e.title AS event_title, e.organization, e.glossary
    FROM audio_chunks c JOIN lectures l ON l.id=c.lecture_id JOIN events e ON e.id=l.event_id
    WHERE (
        c.status='pending'
        OR (c.status='failed' AND c.attempts < ?)
      )
      AND (? IS NULL OR c.lecture_id = ?)
      AND c.next_attempt_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM audio_chunks earlier
        WHERE earlier.lecture_id=c.lecture_id AND earlier.sequence<c.sequence
          AND earlier.status!='done'
          AND NOT (earlier.status='failed' AND earlier.attempts >= ?)
      )
    ORDER BY c.created_at LIMIT 1
  `).get(MAX_CHUNK_ATTEMPTS, lectureId ?? null, lectureId ?? null, now(), MAX_CHUNK_ATTEMPTS);
}

export function peekNextQueuedChunkId(lectureId?: string): string | undefined {
  return nextChunk(lectureId)?.id;
}

export function getLatestTranscriptContext(lectureId: string): string {
  const row = db.prepare(`
    SELECT COALESCE(NULLIF(override_text, ''), raw_text) AS text
    FROM transcript_segments WHERE lecture_id=? ORDER BY end_ms DESC LIMIT 1
  `).get(lectureId) as { text: string } | undefined;
  return row?.text || "";
}

async function compressToFlac(wavPath: string): Promise<string> {
  const executable = ffmpegPath;
  if (!executable || !fs.existsSync(wavPath)) return "";
  const flacPath = wavPath.replace(/\.wav$/i, ".flac");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, "-compression_level", "8", flacPath]);
    let error = "";
    child.stderr.on("data", (data: Buffer) => { error += String(data); });
    child.on("error", reject);
    child.on("close", (code: number | null) => code === 0 ? resolve() : reject(new Error(error || `ffmpeg 종료 코드 ${code}`)));
  });
  return flacPath;
}

function reserveTranscription(chunk: any): UsageReservation {
  return reserveUsage({
    eventId: chunk.event_id,
    lectureId: chunk.lecture_id,
    provider: "openai",
    model: STT_MODEL,
    kind: "transcription",
    maxCostUsd: transcriptionCost(Math.max(0, Number(chunk.duration_ms))) + 0.0001,
    ttlMs: 5 * 60_000
  });
}

export async function processChunk(chunk: any, signal?: AbortSignal): Promise<void> {
  const apiKey = await getSecret("openai");
  if (!apiKey) throw new TerminalChunkError("OpenAI API 키가 없습니다. 설정에서 키를 저장하면 저장된 음성부터 다시 받아씁니다.");

  const reservation = reserveTranscription(chunk);
  let previous: { text: string } | undefined;
  let result: any;
  try {
    db.prepare("UPDATE audio_chunks SET status='processing', attempts=attempts+1, error='', updated_at=? WHERE id=?").run(now(), chunk.id);
    const previousText = getLatestTranscriptContext(chunk.lecture_id);
    previous = previousText ? { text: previousText } : undefined;
    // Several people around one microphone: hint at overlapping, conversational speech.
    const prompt = `여러 사람이 한 마이크 앞에서 나누는 한국어 회의 대화입니다. 회의: ${chunk.lecture_title}. 안건: ${chunk.lecture_topic || "미입력"}. 직전 발언: ${(previous?.text || "").slice(-600)}`;
    const filePath = resolveAudioPath(String(chunk.wav_path || chunk.flac_path || ""));
    result = await transcribeAudio({
      apiKey,
      filePath,
      durationMs: Number(chunk.duration_ms),
      glossary: String(chunk.glossary || ""),
      prompt,
      signal
    });
  } catch (error: any) {
    releaseUsage(reservation);
    // Auth/permission failures will not fix themselves; saving a new key retries them.
    if (error?.terminal) throw new TerminalChunkError(error.message);
    throw error;
  }

  try {
    // Record the billable 2xx response before any transcript parsing or later AI work.
    settleUsage(reservation, result.inputUnits, result.outputUnits, result.costUsd);
  } catch (error) {
    try { settleUsageAtReservation(reservation); } catch { /* original database error is more useful */ }
    throw new TerminalChunkError(`전사 호출 비용 기록에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`, true);
  }

  const rawText = result.text;
  const cleanText = previous ? dedupeOverlap(previous.text, rawText) : rawText;
  const timestamp = now();
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO transcript_segments(
        id,lecture_id,chunk_id,start_ms,end_ms,raw_text,override_text,confidence,provider,provider_metadata,created_at
      ) VALUES(?,?,?,?,?,?, '',?,?,?,?)`)
        .run(
          id(), chunk.lecture_id, chunk.id, chunk.start_ms, chunk.end_ms, cleanText,
          result.confidence, result.provider, JSON.stringify(result.metadata), timestamp
        );
      db.prepare("UPDATE audio_chunks SET status='done', error='', updated_at=? WHERE id=?").run(timestamp, chunk.id);
    })();
  } catch (error) {
    throw new TerminalChunkError(`비용이 발생한 전사를 저장하지 못했습니다. 자동 재호출하지 않습니다: ${error instanceof Error ? error.message : String(error)}`, true);
  }

  try {
    const wavPath = resolveAudioPath(String(chunk.wav_path || ""));
    const flacPath = wavPath ? await compressToFlac(wavPath) : "";
    if (flacPath) {
      db.prepare("UPDATE audio_chunks SET flac_path=?, updated_at=? WHERE id=?").run(flacPath, now(), chunk.id);
      fs.unlinkSync(wavPath);
      db.prepare("UPDATE audio_chunks SET wav_path='' WHERE id=?").run(chunk.id);
    }
  } catch (error) {
    db.prepare("UPDATE audio_chunks SET error=? WHERE id=?").run(`FLAC 압축 실패: ${error instanceof Error ? error.message : String(error)}`, chunk.id);
  }

}

function markChunkFailure(chunk: any, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  if (error instanceof BudgetExceededError) {
    db.prepare("UPDATE audio_chunks SET status='budget_blocked', error=?, next_attempt_at=?, updated_at=? WHERE id=?")
      .run(message, "9999-12-31T23:59:59.999Z", now(), chunk.id);
    return;
  }
  if (error instanceof TerminalChunkError) {
    db.prepare("UPDATE audio_chunks SET status='failed', attempts=?, error=?, next_attempt_at=?, updated_at=? WHERE id=?")
      .run(MAX_CHUNK_ATTEMPTS, message, "9999-12-31T23:59:59.999Z", now(), chunk.id);
    return;
  }
  const row = db.prepare("SELECT attempts FROM audio_chunks WHERE id=?").get(chunk.id) as { attempts: number } | undefined;
  const attempts = Math.max(Number(row?.attempts || 0), Number(chunk.attempts || 0) + 1);
  if (attempts >= MAX_CHUNK_ATTEMPTS) {
    db.prepare("UPDATE audio_chunks SET status='failed', attempts=?, error=?, next_attempt_at=?, updated_at=? WHERE id=?")
      .run(attempts, `${message} (자동 재시도 ${MAX_CHUNK_ATTEMPTS}회 소진)`, "9999-12-31T23:59:59.999Z", now(), chunk.id);
    return;
  }
  const delay = Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6));
  db.prepare("UPDATE audio_chunks SET status='failed', attempts=?, error=?, next_attempt_at=?, updated_at=? WHERE id=?")
    .run(attempts, message, new Date(Date.now() + delay).toISOString(), now(), chunk.id);
}

async function runNextChunk(): Promise<void> {
  const chunk = nextChunk();
  if (!chunk) return;
  const controller = new AbortController();
  chunkController = controller;
  try {
    await processChunk(chunk, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      db.prepare("UPDATE audio_chunks SET status='pending',attempts=MAX(0,attempts-1),next_attempt_at=?,error='',updated_at=? WHERE id=? AND status='processing'").run(now(),now(),chunk.id);
    } else markChunkFailure(chunk, error);
  } finally {
    if (chunkController === controller) chunkController = undefined;
  }
}

export function runQueueOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runNextChunk().finally(() => { inFlight = undefined; });
  return inFlight;
}

/** Returns stale in-flight rows to the durable queue after the single-instance lock is held. */
export function recoverStaleProcessingChunks(): number {
  const timestamp = now();
  return db.prepare(`
    UPDATE audio_chunks
    SET status=CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        error=CASE WHEN attempts >= ?
          THEN '앱 종료 전에 중단되었고 자동 재시도 한도를 소진했습니다. 수동 재시도가 필요합니다.'
          ELSE '앱 종료 전에 중단되어 자동 복구 대기열로 돌아왔습니다.' END,
        next_attempt_at=CASE WHEN attempts >= ? THEN '9999-12-31T23:59:59.999Z' ELSE ? END,
        updated_at=?
    WHERE status='processing'
  `).run(MAX_CHUNK_ATTEMPTS, MAX_CHUNK_ATTEMPTS, MAX_CHUNK_ATTEMPTS, timestamp, timestamp).changes;
}

export function startQueueWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  recoverStaleProcessingChunks();
  timer = setInterval(() => void runQueueOnce(), QUEUE_INTERVAL_MS);
  timer.unref();
  void runQueueOnce();
}

/** Stops scheduling new work and waits for the current API/DB operation to settle. */
export async function stopQueueWorker(): Promise<void> {
  workerStarted = false;
  if (timer) clearInterval(timer);
  timer = undefined;
  chunkController?.abort();
  await inFlight;
}

/** User-triggered retry resets terminal attempts and budget-blocked rows explicitly. */
export function wakeQueue(): number {
  const changes = db.prepare(`
    UPDATE audio_chunks SET status='pending', attempts=0, next_attempt_at=?, error=''
    WHERE status IN ('failed','budget_blocked')
  `).run(now()).changes;
  if (workerStarted) void runQueueOnce();
  return changes;
}

export function retryChunk(chunkId: string): boolean {
  const changed = db.prepare(`
    UPDATE audio_chunks SET status='pending', attempts=0, next_attempt_at=?, error=''
    WHERE id=? AND status IN ('failed','budget_blocked')
  `).run(now(), chunkId).changes > 0;
  if (changed && workerStarted) void runQueueOnce();
  return changed;
}

export function kickQueue(): void {
  if (workerStarted) void runQueueOnce();
}
