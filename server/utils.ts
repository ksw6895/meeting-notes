import { randomUUID } from "node:crypto";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const comparable = (value: string) => value.toLocaleLowerCase("ko").replace(/[\s.,!?;:'"“”‘’()[\]{}\-_/]/g, "");

export function dedupeOverlap(previousText: string, nextText: string): string {
  const previousTokens = previousText.trim().split(/\s+/).filter(Boolean);
  const nextTokens = nextText.trim().split(/\s+/).filter(Boolean);
  // A transcription model sometimes emits one or two bridge words before
  // repeating the true overlap (for example, "치료를 가능한 조기에 고려합니다").
  // Offset matches require at least three tokens so ordinary repeated medical
  // terms such as a drug name are not removed.
  for (let trailingFragment = 0; trailingFragment <= Math.min(1, previousTokens.length - 1); trailingFragment += 1) {
    const previousEnd = previousTokens.length - trailingFragment;
    for (let offset = 0; offset <= Math.min(2, nextTokens.length - 1); offset += 1) {
      const minimum = offset === 0 && trailingFragment === 0 ? 2 : 3;
      const max = Math.min(28, previousEnd, nextTokens.length - offset);
      for (let size = max; size >= minimum; size -= 1) {
        const left = previousTokens.slice(previousEnd - size, previousEnd).map(comparable).join("");
        const right = nextTokens.slice(offset, offset + size).map(comparable).join("");
        if (left.length >= 6 && left === right) return nextTokens.slice(offset + size).join(" ").trim();
      }
    }
  }
  return nextText.trim();
}

export function pcmToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function safeFilename(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "lecture";
}
