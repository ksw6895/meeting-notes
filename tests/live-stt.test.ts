import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-live-stt-"));
process.env.MEETING_NOTES_DATA_DIR = tempDir;
process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY;

const { db } = await import("../server/db.ts");
const live = await import("../server/live-stt.ts");
type RelayMessage = import("../server/live-stt.ts").RealtimeRelayMessage;

const eventId = "live-event";
const lectureId = "live-lecture";
const relays: Array<InstanceType<typeof live.OpenAiLiveRelay>> = [];

/** In-memory stand-in for the OpenAI realtime websocket. Nothing leaves the process. */
class FakeSocket {
  readyState = 0;
  readonly sent: any[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed += 1; this.readyState = 3; }
  emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) || []) listener(...args); }
  open() { this.readyState = 1; this.emit("open"); }
  message(payload: object) { this.emit("message", Buffer.from(JSON.stringify(payload))); }
  of(type: string) { return this.sent.filter((event) => event.type === type); }
}

function tone(ms: number, amplitude = 8_000): Buffer {
  const samples = Math.round(16 * ms);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2);
  return pcm;
}
const silence = (ms: number) => Buffer.alloc(Math.round(16 * ms) * 2);

function makeRelay(glossary = "엔트레스토\n<성우>") {
  const socket = new FakeSocket();
  const messages: RelayMessage[] = [];
  const connect = vi.fn(() => socket);
  const relay = new live.OpenAiLiveRelay({
    eventId, lectureId, apiKey: "sk-test-never-sent", glossary, context: "회의: 주간 회의.",
    emit: (message) => messages.push(message), connect
  });
  relays.push(relay);
  return { relay, socket, messages, connect };
}

beforeAll(() => {
  const at = new Date().toISOString();
  db.prepare("INSERT INTO events(id,title,consent_confirmed,budget_usd,created_at,updated_at) VALUES(?,?,1,0,?,?)").run(eventId, "실시간", at, at);
  db.prepare("INSERT INTO lectures(id,event_id,title,status,created_at,updated_at) VALUES(?,?,?,'recording',?,?)").run(lectureId, eventId, "실시간", at, at);
});
afterEach(async () => {
  vi.useFakeTimers();
  const stopping = Promise.all(relays.splice(0).map((relay) => relay.stop()));
  await vi.advanceTimersByTimeAsync(2_000);
  await stopping;
  vi.useRealTimers();
});
afterAll(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("PCM helpers", () => {
  it("resamples 16 kHz PCM16 to 24 kHz with a 3:2 length ratio", () => {
    for (const samples of [1_600, 16_000, 7]) {
      const output = live.resamplePcm16(Buffer.alloc(samples * 2));
      expect(output.length).toBe(Math.floor((samples * 3) / 2) * 2);
    }
    expect(live.resamplePcm16(Buffer.alloc(0))).toHaveLength(0);
    expect(live.resamplePcm16(Buffer.alloc(3_200), 16_000, 16_000)).toHaveLength(3_200);
  });

  it("interpolates between neighbouring samples", () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(0, 0);
    input.writeInt16LE(300, 2);
    const output = live.resamplePcm16(input);
    expect([0, 1, 2].map((index) => output.readInt16LE(index * 2))).toEqual([0, 200, 300]);
  });

  it("measures RMS on a 0..1 scale", () => {
    expect(live.pcmRms(silence(100))).toBe(0);
    expect(live.pcmRms(Buffer.alloc(0))).toBe(0);
    const full = Buffer.alloc(4);
    full.writeInt16LE(-32_768, 0);
    full.writeInt16LE(-32_768, 2);
    expect(live.pcmRms(full)).toBe(1);
    expect(live.pcmRms(tone(100))).toBeGreaterThan(0.012);
  });
});

describe("OpenAiLiveRelay", () => {
  it("configures a Korean gpt-live-transcribe session without server VAD", () => {
    const { relay, socket, messages, connect } = makeRelay();
    relay.start();
    relay.start();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent).toHaveLength(1);
    const update = socket.sent[0];
    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("transcription");
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(update.session.audio.input.turn_detection).toBeNull();
    expect(update.session.audio.input.transcription).toMatchObject({ model: "gpt-live-transcribe", languages: ["ko"], keywords: ["엔트레스토", "성우"] });
    expect(update.session.audio.input.transcription.prompt).toContain("주간 회의");
    expect(messages).toContainEqual({ type: "transcript_status", status: "connected" });
  });

  it("omits keywords when the glossary is empty", () => {
    const { relay, socket } = makeRelay("");
    relay.start();
    socket.open();
    expect(socket.sent[0].session.audio.input.transcription).not.toHaveProperty("keywords");
  });

  it("buffers audio until the socket is open, then appends base64 24 kHz PCM and bills it", async () => {
    const { relay, socket, connect } = makeRelay();
    const pcm = tone(1_000);
    relay.forward(pcm);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(socket.of("input_audio_buffer.append")).toHaveLength(0);
    socket.open();
    const appends = socket.of("input_audio_buffer.append");
    expect(appends).toHaveLength(1);
    const decoded = Buffer.from(appends[0].audio, "base64");
    expect(decoded.equals(live.resamplePcm16(pcm))).toBe(true);
    expect(decoded.length).toBe(pcm.length * 1.5);
    const rows = () => db.prepare("SELECT model,kind,input_units,cost_usd FROM usage_ledger WHERE lecture_id=? AND model='gpt-live-transcribe'").all(lectureId) as any[];
    const before = rows().length;
    // Usage is batched: one ledger row per minute of live audio, or when the relay stops.
    for (let i = 0; i < 59; i += 1) relay.forward(silence(1_000));
    expect(rows()).toHaveLength(before + 1);
    expect(rows().at(-1)).toMatchObject({ model: "gpt-live-transcribe", kind: "transcription" });
    expect(rows().at(-1).cost_usd).toBeCloseTo(0.017, 10);
    relay.forward(tone(1_000));
    await relay.stop();
    expect(rows()).toHaveLength(before + 2);
    expect(rows().at(-1).cost_usd).toBeCloseTo(0.017 / 60, 10);
    expect(db.prepare("SELECT COUNT(*) AS n FROM billing_reservations").get()).toMatchObject({ n: 0 });
  });

  it("commits a turn after speech followed by a pause", () => {
    const { relay, socket } = makeRelay();
    relay.start();
    socket.open();
    for (let i = 0; i < 18; i += 1) relay.forward(tone(100));
    expect(socket.of("input_audio_buffer.commit")).toHaveLength(0);
    relay.forward(silence(100));
    expect(socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    expect(socket.of("input_audio_buffer.commit")).toHaveLength(1);
    // Silence without new speech does not produce empty commits.
    for (let i = 0; i < 30; i += 1) relay.forward(silence(100));
    expect(socket.of("input_audio_buffer.commit")).toHaveLength(1);
  });

  it("does not commit a pause that comes before 1.8 s of buffered audio", () => {
    const { relay, socket } = makeRelay();
    relay.start();
    socket.open();
    for (let i = 0; i < 5; i += 1) relay.forward(tone(100));
    relay.forward(silence(100));
    expect(socket.of("input_audio_buffer.commit")).toHaveLength(0);
  });

  it("commits continuous speech at the 10 s cap", () => {
    const { relay, socket } = makeRelay();
    relay.start();
    socket.open();
    for (let i = 0; i < 9; i += 1) relay.forward(tone(1_000));
    expect(socket.of("input_audio_buffer.commit")).toHaveLength(0);
    relay.forward(tone(1_000));
    expect(socket.of("input_audio_buffer.append")).toHaveLength(10);
    expect(socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    for (let i = 0; i < 10; i += 1) relay.forward(tone(1_000));
    expect(socket.of("input_audio_buffer.commit")).toHaveLength(2);
  });

  it("emits delta events as transcript_partial and completed events as transcript_committed", () => {
    const { relay, socket, messages } = makeRelay();
    relay.start();
    socket.open();
    messages.length = 0;
    socket.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "다음 회의는" });
    socket.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: " 금요일" });
    socket.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "b", delta: "좋습니다" });
    expect(messages).toEqual([
      { type: "transcript_partial", text: "다음 회의는" },
      { type: "transcript_partial", text: "다음 회의는 금요일" },
      { type: "transcript_partial", text: "다음 회의는 금요일 좋습니다" }
    ]);
    messages.length = 0;
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: " 다음 회의는 금요일입니다. " });
    expect(messages).toEqual([
      { type: "transcript_committed", text: "다음 회의는 금요일입니다." },
      { type: "transcript_partial", text: "좋습니다" }
    ]);
    messages.length = 0;
    socket.emit("message", "not json");
    socket.message({ type: "error", error: { code: "input_audio_buffer_commit_empty", message: "empty" } });
    expect(messages).toEqual([]);
  });

  it("disables itself on a terminal API error and degrades on others", () => {
    const { relay, socket, messages } = makeRelay();
    relay.start();
    socket.open();
    socket.message({ type: "error", error: { code: "rate_limit_exceeded", message: "slow down" } });
    expect(messages.at(-1)).toMatchObject({ type: "transcript_status", status: "degraded" });
    expect(socket.closed).toBe(0);
    socket.message({ type: "error", error: { code: "invalid_api_key", message: "bad key" } });
    expect(messages.at(-1)).toMatchObject({ type: "transcript_status", status: "disabled" });
    expect(socket.closed).toBe(1);
    const sentBefore = socket.sent.length;
    relay.forward(tone(1_000));
    expect(socket.sent).toHaveLength(sentBefore);
  });

  it("treats a 401 handshake as terminal and reconnects with backoff after a transient close", async () => {
    vi.useFakeTimers();
    try {
      const rejected = makeRelay();
      rejected.relay.start();
      rejected.socket.emit("unexpected-response", {}, { statusCode: 401 });
      expect(rejected.messages.at(-1)).toMatchObject({ type: "transcript_status", status: "disabled" });
      rejected.socket.emit("close");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rejected.connect).toHaveBeenCalledTimes(1);

      const flaky = makeRelay();
      flaky.relay.start();
      flaky.socket.open();
      flaky.socket.emit("error", new Error("ECONNRESET"));
      expect(flaky.messages.at(-1)).toMatchObject({ type: "transcript_status", status: "batch_fallback" });
      flaky.socket.emit("close");
      expect(flaky.connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(flaky.connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits the tail on stop and closes the socket", async () => {
    const { relay, socket } = makeRelay();
    relay.start();
    socket.open();
    relay.forward(tone(500));
    vi.useFakeTimers();
    try {
      const stopping = relay.stop();
      expect(socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
      await vi.advanceTimersByTimeAsync(1_500);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
    expect(socket.closed).toBe(1);
  });
});
