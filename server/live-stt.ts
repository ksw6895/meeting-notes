import WebSocket from "ws";
import { releaseUsage, reserveUsage, settleUsage } from "./billing.ts";
import { extractKeywords, LIVE_STT_MODEL, liveTranscriptionCost } from "./stt.ts";

const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000; // gpt-live-transcribe documents 24 kHz mono PCM16.
const MAX_BUFFERED_MS = 30_000;
const SPEECH_RMS = 0.012;
const MIN_COMMIT_MS = 1_800;
const MAX_COMMIT_MS = 10_000;
const LEDGER_BATCH_MS = 60_000; // one usage row per minute of live audio, not per packet

export interface LiveSocket {
  readonly readyState: number;
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(): void;
}

export interface RealtimeRelayMessage {
  type: "transcript_partial" | "transcript_committed" | "transcript_status";
  text?: string;
  status?: string;
  message?: string;
}

export interface RealtimeRelayOptions {
  eventId: string;
  lectureId: string;
  apiKey: string;
  glossary: string;
  context: string;
  emit(message: RealtimeRelayMessage): void;
  connect?: () => LiveSocket;
}

/** 16 kHz → 24 kHz linear resampling of signed 16-bit little-endian mono PCM. */
export function resamplePcm16(pcm: Buffer, from = INPUT_RATE, to = OUTPUT_RATE): Buffer {
  const inputSamples = Math.floor(pcm.length / 2);
  if (!inputSamples) return Buffer.alloc(0);
  const outputSamples = Math.floor(inputSamples * to / from);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i += 1) {
    const position = i * from / to;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = pcm.readInt16LE(index * 2);
    const b = index + 1 < inputSamples ? pcm.readInt16LE((index + 1) * 2) : a;
    output.writeInt16LE(Math.round(a + (b - a) * fraction), i * 2);
  }
  return output;
}

export function pcmRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Relays recorded audio to OpenAI's realtime transcription session for a fast preview.
 * The model has no server VAD, so this relay commits a turn after a pause or every ~10 s.
 * The 30-second batch transcript remains the source of truth; failures here only cost the preview.
 */
export class OpenAiLiveRelay {
  private socket?: LiveSocket;
  private ready = false;
  private stopped = false;
  private budgetBlocked = false;
  private readonly pending: Buffer[] = [];
  private pendingMs = 0;
  private uncommittedMs = 0;
  private speechMs = 0;
  private unbilledMs = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private failures = 0;
  private readonly partials = new Map<string, string>();
  private readonly keywords: string[];

  constructor(private readonly options: RealtimeRelayOptions) {
    this.keywords = extractKeywords(options.glossary, 50);
  }

  start(): void {
    if (this.stopped || this.socket) return;
    const socket = this.options.connect?.() ?? new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: `Bearer ${this.options.apiKey}` }
    });
    this.socket = socket;
    this.ready = false;
    socket.on("open", () => {
      if (this.socket !== socket) return;
      const prompt = `한국어 회의 녹음입니다. ${this.options.context}`.slice(0, 1000);
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OUTPUT_RATE },
              transcription: {
                model: LIVE_STT_MODEL,
                languages: ["ko"],
                prompt,
                ...(this.keywords.length ? { keywords: this.keywords } : {})
              },
              turn_detection: null
            }
          }
        }
      }));
      this.ready = true;
      this.failures = 0;
      this.options.emit({ type: "transcript_status", status: "connected" });
      this.drain();
    });
    socket.on("message", (raw: Buffer | string) => this.handleEvent(String(raw)));
    socket.on("unexpected-response", (_request: unknown, response: { statusCode?: number }) => {
      const status = Number(response?.statusCode || 0);
      // 400/404 (no access to the model) will not fix itself by reconnecting either.
      this.fail([400, 401, 403, 404].includes(status), `실시간 받아쓰기 연결 거부 (${status}). 30초 정밀 받아쓰기는 계속됩니다.`);
    });
    socket.on("error", (error: Error) => { if (!this.stopped) this.fail(false, `실시간 받아쓰기 연결 오류: ${error.message}`); });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      this.partials.clear();
      this.uncommittedMs = 0;
      this.speechMs = 0;
      if (!this.stopped && !this.budgetBlocked) this.scheduleReconnect();
    });
  }

  private handleEvent(raw: string): void {
    let event: any;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
      const itemId = String(event.item_id || "");
      this.partials.set(itemId, (this.partials.get(itemId) || "") + event.delta);
      this.options.emit({ type: "transcript_partial", text: [...this.partials.values()].join(" ").trim() });
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      this.partials.delete(String(event.item_id || ""));
      const text = String(event.transcript || "").trim();
      if (text) this.options.emit({ type: "transcript_committed", text });
      this.options.emit({ type: "transcript_partial", text: [...this.partials.values()].join(" ").trim() });
    } else if (event.type === "conversation.item.input_audio_transcription.failed") {
      this.partials.delete(String(event.item_id || ""));
    } else if (event.type === "error") {
      const code = String(event.error?.code || "");
      // An empty-buffer commit is harmless; anything else is surfaced once.
      if (code === "input_audio_buffer_commit_empty") return;
      const terminal = ["invalid_api_key", "insufficient_quota", "model_not_found"].includes(code);
      this.options.emit({ type: "transcript_status", status: terminal ? "disabled" : "degraded", message: String(event.error?.message || "실시간 받아쓰기 오류") });
      if (terminal) { this.stopped = true; this.socket?.close(); }
    }
  }

  private fail(terminal: boolean, message: string): void {
    this.ready = false;
    this.options.emit({ type: "transcript_status", status: terminal ? "disabled" : "batch_fallback", message });
    if (terminal) this.stopped = true;
    try { this.socket?.close(); } catch { /* already closed */ }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_500 * 2 ** Math.min(this.failures++, 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.start();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  forward(pcm: Buffer): void {
    if (this.stopped || this.budgetBlocked || !pcm.length) return;
    this.pending.push(Buffer.from(pcm));
    this.pendingMs += (pcm.length / 2 / INPUT_RATE) * 1000;
    while (this.pendingMs > MAX_BUFFERED_MS && this.pending.length) {
      const dropped = this.pending.shift()!;
      this.pendingMs -= (dropped.length / 2 / INPUT_RATE) * 1000;
    }
    // Reconnects go through scheduleReconnect's backoff, not once per incoming packet.
    if (!this.socket && !this.reconnectTimer) this.start();
    this.drain();
  }

  private drain(): void {
    while (this.ready && this.socket?.readyState === WebSocket.OPEN && this.pending.length && !this.stopped && !this.budgetBlocked) {
      const pcm = this.pending[0];
      const durationMs = (pcm.length / 2 / INPUT_RATE) * 1000;
      try {
        this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: resamplePcm16(pcm).toString("base64") }));
      } catch {
        this.socket.close();
        return;
      }
      this.unbilledMs += durationMs;
      if (this.unbilledMs >= LEDGER_BATCH_MS && !this.bill()) return;
      this.pending.shift();
      this.pendingMs -= durationMs;
      this.uncommittedMs += durationMs;
      const speaking = pcmRms(pcm) >= SPEECH_RMS;
      if (speaking) this.speechMs += durationMs;
      const pause = !speaking && this.speechMs > 0 && this.uncommittedMs >= MIN_COMMIT_MS;
      if (pause || this.uncommittedMs >= MAX_COMMIT_MS) this.commit();
    }
  }

  /** Records sent live audio in the usage ledger. Returns false when the budget blocks further audio. */
  private bill(): boolean {
    if (this.unbilledMs <= 0) return true;
    const durationMs = this.unbilledMs;
    const costUsd = liveTranscriptionCost(durationMs);
    let reservation;
    try {
      reservation = reserveUsage({
        eventId: this.options.eventId, lectureId: this.options.lectureId, provider: "openai",
        model: LIVE_STT_MODEL, kind: "transcription", maxCostUsd: costUsd + 0.000001, ttlMs: 60_000
      });
    } catch (error) {
      this.budgetBlocked = true;
      this.options.emit({ type: "transcript_status", status: "budget_blocked", message: error instanceof Error ? error.message : "비용 한도에 도달했습니다." });
      this.socket?.close();
      return false;
    }
    try { settleUsage(reservation, durationMs / 60_000, 0, costUsd); }
    catch { releaseUsage(reservation); }
    this.unbilledMs = 0;
    return true;
  }

  private commit(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.uncommittedMs < 200) return;
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.uncommittedMs = 0;
    this.speechMs = 0;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.bill();
    if (this.ready) {
      try { this.commit(); } catch { /* socket already closing */ }
      // Give the last committed turn a moment to come back for the on-screen preview.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = undefined;
    this.ready = false;
    this.pending.length = 0;
    this.pendingMs = 0;
  }
}
