import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { AUDIO_DIR, db } from "./db.ts";
import { id, now, pcmToWav } from "./utils.ts";

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
export const TARGET_MS = 30_000;
export const OVERLAP_MS = 2_000;
export const AUDIO_PACKET_MAGIC = "LN01";
const FSYNC_INTERVAL_MS = 2_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS audio_packet_receipts (
    lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (lecture_id, session_id, sequence)
  );
`);

function ensureLectureDir(lectureId: string): string {
  const dir = path.join(AUDIO_DIR, lectureId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFileDurably(filePath: string, contents: Buffer): void {
  const fd = fs.openSync(filePath, "wx");
  try {
    writeAllSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAllSync(fd: number, contents: Buffer): void {
  let offset = 0;
  while (offset < contents.length) {
    const written = fs.writeSync(fd, contents, offset, contents.length - offset);
    if (written <= 0) throw new Error(`파일 쓰기가 중단되었습니다 (${offset}/${contents.length} bytes).`);
    offset += written;
  }
}

export interface ParsedAudioPacket {
  sessionId: string;
  sequence: number;
  pcm: Buffer;
}

/**
 * Binary websocket packet:
 * LN01 | uint16 BE session UTF-8 byte length | uint32 BE sequence | session | s16le PCM.
 */
export function parseAudioPacket(value: Buffer): ParsedAudioPacket {
  if (value.length < 12 || value.subarray(0, 4).toString("ascii") !== AUDIO_PACKET_MAGIC) {
    throw new Error("지원하지 않는 오디오 패킷입니다.");
  }
  const sessionLength = value.readUInt16BE(4);
  const sequence = value.readUInt32BE(6);
  const payloadStart = 10 + sessionLength;
  if (sessionLength < 1 || sessionLength > 256 || payloadStart > value.length) {
    throw new Error("오디오 패킷의 세션 ID가 올바르지 않습니다.");
  }
  const sessionId = value.subarray(10, payloadStart).toString("utf8").trim();
  const pcm = value.subarray(payloadStart);
  if (!sessionId || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("오디오 패킷의 PCM 데이터가 올바르지 않습니다.");
  }
  return { sessionId, sequence, pcm };
}

export class LectureAudioWriter {
  readonly lectureId: string;
  private readonly lectureDir: string;
  private readonly journalPath: string;
  private fd: number;
  private sequence: number;
  private lastChunkEndMs: number;
  private recordedBytes: number;
  private recordedMs: number;
  private closed = false;
  private lastDbSync = 0;
  private readonly syncTimer: NodeJS.Timeout;
  private durabilityError?: Error;

  constructor(lectureId: string) {
    this.lectureId = lectureId;
    this.lectureDir = ensureLectureDir(lectureId);
    this.journalPath = path.join(this.lectureDir, "recording.pcm");
    this.fd = fs.openSync(this.journalPath, "a+");
    this.recordedBytes = fs.fstatSync(this.fd).size;
    if (this.recordedBytes % 2 !== 0) {
      this.recordedBytes -= 1;
      fs.ftruncateSync(this.fd, this.recordedBytes);
      fs.fsyncSync(this.fd);
    }
    this.recordedMs = Math.floor(this.recordedBytes / BYTES_PER_MS);
    const latest = db.prepare("SELECT sequence, end_ms FROM audio_chunks WHERE lecture_id = ? ORDER BY sequence DESC LIMIT 1").get(lectureId) as { sequence: number; end_ms: number } | undefined;
    this.sequence = (latest?.sequence ?? -1) + 1;
    this.lastChunkEndMs = latest?.end_ms ?? 0;
    if (this.lastChunkEndMs > this.recordedMs) {
      fs.closeSync(this.fd);
      throw new Error("원본 오디오 저널이 기존 청크보다 짧습니다. 오디오를 복원하거나 새 회의를 만드세요.");
    }
    this.syncLecture();
    this.syncTimer = setInterval(() => {
      try { this.flushDurable(); } catch (error) {
        this.durabilityError = error instanceof Error ? error : new Error(String(error));
      }
    }, FSYNC_INTERVAL_MS);
    this.syncTimer.unref();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get durationMs(): number {
    return this.recordedMs;
  }

  append(pcm: Buffer): void {
    this.appendInternal(pcm, false);
  }

  /**
   * Appends one replayable client packet exactly once during normal reconnects.
   * The journal is fsynced before the receipt is committed and before callers ACK.
   * A process kill in the tiny file/SQLite boundary can duplicate at most one packet,
   * but deliberately cannot acknowledge audio that is not durable on disk.
   */
  appendPacketDurable(sessionId: string, sequence: number, pcm: Buffer): { accepted: boolean } {
    if (this.closed) throw new Error("오디오 writer가 이미 닫혔습니다.");
    const received = db.prepare("SELECT 1 FROM audio_packet_receipts WHERE lecture_id=? AND session_id=? AND sequence=?")
      .get(this.lectureId, sessionId, sequence);
    if (received) return { accepted: false };
    this.appendInternal(pcm, true);
    db.prepare("INSERT INTO audio_packet_receipts(lecture_id,session_id,sequence,received_at) VALUES(?,?,?,?)")
      .run(this.lectureId, sessionId, sequence, now());
    return { accepted: true };
  }

  private appendInternal(pcm: Buffer, durable: boolean): void {
    if (this.closed) throw new Error("오디오 writer가 이미 닫혔습니다.");
    if (this.durabilityError) throw this.durabilityError;
    if (pcm.length === 0) return;
    const even = pcm.length - (pcm.length % 2);
    if (even <= 0) return;
    writeAllSync(this.fd, pcm.subarray(0, even));
    this.recordedBytes += even;
    this.recordedMs = Math.floor(this.recordedBytes / BYTES_PER_MS);
    if (durable) this.flushDurable();
    if (this.recordedMs - this.lastDbSync >= 1000) this.syncLecture();
    while (this.hasFullChunk()) this.finalizeChunk(false);
  }

  flushDurable(): void {
    if (this.durabilityError) throw this.durabilityError;
    if (!this.closed) fs.fsyncSync(this.fd);
  }

  private hasFullChunk(): boolean {
    return this.lastChunkEndMs === 0
      ? this.recordedMs >= TARGET_MS
      : this.recordedMs - this.lastChunkEndMs >= TARGET_MS;
  }

  finalizeChunk(force: boolean): boolean {
    if (this.closed) return false;
    const newAudioMs = this.recordedMs - this.lastChunkEndMs;
    if (!force && !this.hasFullChunk()) return false;
    if (force && newAudioMs < 500) return false;
    const startMs = this.lastChunkEndMs === 0 ? 0 : Math.max(0, this.lastChunkEndMs - OVERLAP_MS);
    const endMs = force ? this.recordedMs : (this.lastChunkEndMs === 0 ? TARGET_MS : this.lastChunkEndMs + TARGET_MS);
    const startByte = Math.floor(startMs * BYTES_PER_MS);
    const byteLength = Math.max(0, Math.floor((endMs - startMs) * BYTES_PER_MS));
    if (byteLength === 0) return false;
    this.flushDurable();
    const pcm = Buffer.allocUnsafe(byteLength);
    const readFd = fs.openSync(this.journalPath, "r");
    try {
      const bytesRead = fs.readSync(readFd, pcm, 0, byteLength, startByte);
      if (bytesRead !== byteLength) throw new Error(`오디오 저널 읽기가 불완전합니다 (${bytesRead}/${byteLength} bytes).`);
    } finally {
      fs.closeSync(readFd);
    }
    const chunkId = id();
    const wavPath = path.join(this.lectureDir, `${String(this.sequence).padStart(5, "0")}-${chunkId}.wav`);
    writeFileDurably(wavPath, pcmToWav(pcm, SAMPLE_RATE));
    const timestamp = now();
    try {
      db.prepare(`
        INSERT INTO audio_chunks(id, lecture_id, sequence, start_ms, end_ms, duration_ms, wav_path, flac_path, status, attempts, next_attempt_at, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', 'pending', 0, ?, '', ?, ?)
      `).run(chunkId, this.lectureId, this.sequence, startMs, endMs, endMs - startMs, wavPath, timestamp, timestamp, timestamp);
    } catch (error) {
      fs.rmSync(wavPath, { force: true });
      throw error;
    }
    this.sequence += 1;
    this.lastChunkEndMs = endMs;
    this.syncLecture();
    return true;
  }

  private syncLecture(): void {
    const timestamp = now();
    db.prepare("UPDATE lectures SET recorded_ms = ?, updated_at = ? WHERE id = ?").run(this.recordedMs, timestamp, this.lectureId);
    this.lastDbSync = this.recordedMs;
  }

  close(flush = true): void {
    if (this.closed) return;
    let closeError: unknown;
    if (flush) {
      try { this.finalizeChunk(true); } catch (error) { closeError = error; }
    }
    clearInterval(this.syncTimer);
    try { fs.fsyncSync(this.fd); } catch (error) { closeError ??= error; }
    try { fs.closeSync(this.fd); } catch (error) { closeError ??= error; }
    try { this.syncLecture(); } catch (error) { closeError ??= error; }
    this.closed = true;
    if (closeError) throw closeError;
  }
}

export class AudioWriterInUseError extends Error {
  readonly code = "AUDIO_WRITER_IN_USE";

  constructor(readonly lectureId: string) {
    super("이 회의는 다른 탭 또는 녹음 세션에서 이미 사용 중입니다.");
    this.name = "AudioWriterInUseError";
  }
}

interface ActiveWriter {
  writer: LectureAudioWriter;
  ownerId: string;
  leases: Set<symbol>;
}

export interface AudioWriterLease {
  writer: LectureAudioWriter;
  release(): void;
}

const activeWriters = new Map<string, ActiveWriter>();

/** Acquire one lecture for one browser recording session; reconnects with the same owner share it. */
export function acquireAudioWriter(lectureId: string, ownerId: string): AudioWriterLease {
  if (!ownerId.trim()) throw new Error("녹음 세션 ID가 필요합니다.");
  const otherActive = [...activeWriters.entries()].find(([activeLectureId, value]) =>
    activeLectureId !== lectureId && !value.writer.isClosed
  );
  if (otherActive) throw new AudioWriterInUseError(otherActive[0]);
  let active = activeWriters.get(lectureId);
  if (active?.writer.isClosed) {
    activeWriters.delete(lectureId);
    active = undefined;
  }
  if (active && active.ownerId !== ownerId) throw new AudioWriterInUseError(lectureId);
  if (!active) {
    active = { writer: new LectureAudioWriter(lectureId), ownerId, leases: new Set() };
    activeWriters.set(lectureId, active);
  }
  const leaseId = Symbol(ownerId);
  active.leases.add(leaseId);
  let released = false;
  return {
    writer: active.writer,
    release() {
      if (released) return;
      released = true;
      const current = activeWriters.get(lectureId);
      if (!current || current.writer !== active!.writer) return;
      current.leases.delete(leaseId);
      if (current.leases.size === 0) {
        activeWriters.delete(lectureId);
        try { current.writer.close(true); } catch (error) {
          console.error("오디오 연결 종료 저장 실패:", error instanceof Error ? error.message : error);
        }
      }
    }
  };
}

/** Legacy helper for local tests; websocket routes should use acquireAudioWriter. */
export function openAudioWriter(lectureId: string): LectureAudioWriter {
  const active = activeWriters.get(lectureId);
  if (active) return active.writer;
  const writer = new LectureAudioWriter(lectureId);
  activeWriters.set(lectureId, { writer, ownerId: "legacy", leases: new Set() });
  return writer;
}

export function forceCloseAudioWriter(lectureId: string): void {
  const active = activeWriters.get(lectureId);
  activeWriters.delete(lectureId);
  active?.writer.close(true);
}

/** Backwards-compatible state-transition close; websocket routes should release their lease. */
export function closeAudioWriter(lectureId: string): void {
  forceCloseAudioWriter(lectureId);
}

export function forceCloseAllAudioWriters(): void {
  let firstError: unknown;
  for (const lectureId of [...activeWriters.keys()]) {
    try { forceCloseAudioWriter(lectureId); } catch (error) { firstError ??= error; }
  }
  if (firstError) throw firstError;
}

export function hasActiveAudioWriter(lectureId: string): boolean {
  return activeWriters.has(lectureId);
}

/** True while a browser connection is actually streaming into this meeting. */
export function hasLiveAudioLease(lectureId: string): boolean {
  const active = activeWriters.get(lectureId);
  return Boolean(active && active.leases.size > 0 && !active.writer.isClosed);
}

/** Chunk paths are stored absolute; if the app folder moved, find the file under the current AUDIO_DIR. */
export function resolveAudioPath(stored: string): string {
  if (!stored || fs.existsSync(stored)) return stored;
  const candidate = path.join(AUDIO_DIR, path.basename(path.dirname(stored)), path.basename(stored));
  return fs.existsSync(candidate) ? candidate : stored;
}

export function getLectureJournalPath(lectureId: string): string {
  return path.join(AUDIO_DIR, lectureId, "recording.pcm");
}

export function getLectureStorageStats(lectureId: string): { originalBytes: number; storageBytes: number } {
  const lectureDir = path.join(AUDIO_DIR, lectureId);
  if (!fs.existsSync(lectureDir)) return { originalBytes: 0, storageBytes: 0 };
  let storageBytes = 0;
  for (const entry of fs.readdirSync(lectureDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    storageBytes += fs.statSync(path.join(lectureDir, entry.name)).size;
  }
  const journal = getLectureJournalPath(lectureId);
  return { originalBytes: fs.existsSync(journal) ? fs.statSync(journal).size : 0, storageBytes };
}

/** Generates one continuous FLAC without loading the potentially 8-hour PCM journal into memory. */
export async function generateLectureFlac(lectureId: string, destination?: string): Promise<string> {
  if (hasActiveAudioWriter(lectureId)) throw new Error("녹음을 일시정지하거나 종료한 뒤 오디오를 내보내세요.");
  const source = getLectureJournalPath(lectureId);
  if (!fs.existsSync(source) || fs.statSync(source).size === 0) throw new Error("저장된 원본 오디오가 없습니다.");
  const executable = ffmpegPath;
  if (!executable) throw new Error("FFmpeg 실행 파일을 찾을 수 없습니다.");
  const output = destination || path.join(ensureLectureDir(lectureId), "session.flac");
  if (fs.existsSync(output)) {
    const sourceStat = fs.statSync(source);
    const outputStat = fs.statSync(output);
    if (outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs) return output;
  }
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp.flac`;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", source,
        "-compression_level", "8", temporary
      ]);
      let error = "";
      child.stderr.on("data", (data: Buffer) => { error += String(data); });
      child.on("error", reject);
      child.on("close", (code: number | null) => code === 0 ? resolve() : reject(new Error(error || `ffmpeg 종료 코드 ${code}`)));
    });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return output;
}

export function recoverAudioJournals(): void {
  const lectureRows = db.prepare("SELECT id FROM lectures").all() as Array<{ id: string }>;
  for (const { id: lectureId } of lectureRows) {
    const journal = getLectureJournalPath(lectureId);
    if (!fs.existsSync(journal)) continue;
    // One damaged journal must not keep the whole app from starting.
    try {
      const writer = new LectureAudioWriter(lectureId);
      writer.finalizeChunk(true);
      writer.close(false);
    } catch (error) {
      console.error(`[audio] ${lectureId} 복구 실패:`, error instanceof Error ? error.message : error);
      db.prepare("UPDATE lectures SET note_error=? WHERE id=?").run(`음성 저널 복구 실패: ${error instanceof Error ? error.message : String(error)}`, lectureId);
    }
  }
  // A lecture can be marked recording before the browser opens its websocket,
  // so the absence of a journal does not mean it is safe to leave recording on restart.
  db.prepare("UPDATE lectures SET status='paused', updated_at=? WHERE status='recording'").run(now());
}
