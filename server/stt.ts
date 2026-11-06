import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";

// Pricing verified 2026-11-06: https://developers.openai.com/api/docs/pricing
export const STT_MODEL = "gpt-transcribe" as const;
export const STT_USD_PER_MINUTE = 0.0045;
export const LIVE_STT_MODEL = "gpt-live-transcribe" as const;
export const LIVE_STT_USD_PER_MINUTE = 0.017;
export type SttModel = typeof STT_MODEL;

export interface SttResult {
  provider: "openai";
  model: SttModel;
  text: string;
  confidence: number | null;
  inputUnits: number;
  outputUnits: number;
  costUsd: number;
  metadata: Record<string, unknown>;
}

export interface TranscribeAudioInput {
  apiKey: string;
  filePath: string;
  durationMs: number;
  glossary: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface PreparedSttAudio {
  filePath: string;
  normalized: boolean;
  warning?: string;
  cleanup(): void;
}

/** Conservative speech normalization only; no denoising and the source is never modified. */
export async function prepareAudio(sourcePath: string, executable: string | null = ffmpegPath): Promise<PreparedSttAudio> {
  if (!fs.existsSync(sourcePath)) throw new Error(`전사할 오디오 파일이 없습니다: ${path.basename(sourcePath)}`);
  // gpt-transcribe does not list FLAC, so a FLAC source is always re-encoded to WAV.
  const fallback = sourcePath.toLowerCase().endsWith(".wav") ? sourcePath : "";
  if (!executable) {
    if (!fallback) throw new Error("FFmpeg를 찾지 못해 FLAC 구간을 전사할 수 없습니다. npm install을 다시 실행하세요.");
    return { filePath: fallback, normalized: false, warning: "FFmpeg를 찾지 못해 원본 음량으로 전사합니다.", cleanup() {} };
  }
  const temporary = path.join(path.dirname(sourcePath), `.stt-${process.pid}-${randomUUID()}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
        "-af", "highpass=f=70,loudnorm=I=-18:TP=-2:LRA=11",
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", temporary
      ]);
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + String(data)).slice(-1000); });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => finish(code === 0 ? undefined : new Error(stderr || `ffmpeg 종료 코드 ${code}`)));
    });
    if (!fs.existsSync(temporary) || fs.statSync(temporary).size <= 44) throw new Error("정규화 결과가 비어 있습니다.");
    return { filePath: temporary, normalized: true, cleanup() { fs.rmSync(temporary, { force: true }); } };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fallback) throw error;
    return {
      filePath: fallback,
      normalized: false,
      warning: `음량 정규화에 실패해 원본으로 전사합니다: ${error instanceof Error ? error.message : String(error)}`,
      cleanup() {}
    };
  }
}

/** Glossary → keyword hints. The API rejects the whole request for `<`, `>` or line breaks. */
export function extractKeywords(glossary: string, limit = 100): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of glossary.split(/[\n,;|]+/u)) {
    const cleaned = candidate
      .replace(/^\s*(?:(?:\d+[.)])|[-–—•*])\s*/u, "")
      .replace(/[<>{}\[\]\\\r\n]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!cleaned) continue;
    const limited = [...cleaned].slice(0, 50).join("");
    const comparable = limited.toLocaleLowerCase("ko");
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(limited);
    if (result.length >= limit) break;
  }
  return result;
}

export function transcriptionCost(durationMs: number): number {
  return (Math.max(0, durationMs) / 60_000) * STT_USD_PER_MINUTE;
}

export function liveTranscriptionCost(durationMs: number): number {
  return (Math.max(0, durationMs) / 60_000) * LIVE_STT_USD_PER_MINUTE;
}

export function openAiErrorHint(status: number): string {
  if (status === 401) return "설정에서 OpenAI 키를 다시 저장하세요.";
  if (status === 403 || status === 404) return "이 키의 프로젝트가 해당 모델에 접근할 수 있는지 확인하세요.";
  if (status === 429) return "사용 한도나 결제 상태를 확인하세요.";
  return "잠시 후 자동으로 다시 시도합니다.";
}

export async function transcribeAudio(input: TranscribeAudioInput): Promise<SttResult> {
  const prepared = await prepareAudio(input.filePath);
  try {
    const keywords = extractKeywords(input.glossary);
    const form = new FormData();
    const bytes = await fs.promises.readFile(prepared.filePath);
    form.append("file", new Blob([bytes], { type: "audio/wav" }), "chunk.wav");
    form.append("model", STT_MODEL);
    form.append("response_format", "json");
    form.append("languages[]", "ko");
    if (input.prompt.trim()) form.append("prompt", input.prompt.slice(0, 2000));
    for (const keyword of keywords) form.append("keywords[]", keyword);
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
    });
    if (!response.ok) {
      // Provider bodies are not echoed: they can contain the prompt.
      throw Object.assign(new Error(`OpenAI 전사 ${response.status}: ${openAiErrorHint(response.status)}`), {
        terminal: response.status === 401 || response.status === 403 || response.status === 404
      });
    }
    const result = await response.json() as any;
    const minutes = Math.max(0, input.durationMs / 60_000);
    return {
      provider: "openai",
      model: STT_MODEL,
      text: String(result.text || "").trim(),
      confidence: null,
      inputUnits: minutes,
      outputUnits: 0,
      costUsd: transcriptionCost(input.durationMs),
      metadata: {
        languages: Array.isArray(result.languages) ? result.languages : [],
        keywordsUsed: keywords,
        audioNormalization: { applied: prepared.normalized, warning: prepared.warning || null }
      }
    };
  } finally {
    prepared.cleanup();
  }
}
