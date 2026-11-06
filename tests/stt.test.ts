import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pcmToWav } from "../server/utils.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-stt-"));
process.env.MEETING_NOTES_DATA_DIR = tempDir;
process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY;

// No subprocess in the request-shape tests: without FFmpeg a WAV is sent as-is.
vi.mock("ffmpeg-static", () => ({ default: null }));

const stt = await import("../server/stt.ts");
const realFfmpeg = (await vi.importActual<{ default: string | null }>("ffmpeg-static")).default;
const wavPath = path.join(tempDir, "speech.wav");
fs.writeFileSync(wavPath, pcmToWav(Buffer.alloc(3_200)));

const okResponse = (text = " 다음 회의는 금요일입니다. ") => new Response(JSON.stringify({ text, languages: ["ko"] }), { status: 200 });

afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

describe("keyword hints and pricing", () => {
  it("strips characters the API rejects, list markers and duplicates", () => {
    const keywords = stt.extractKeywords("1. 엔트레스토\n- <script>홍길동</script>, 홍길동; [지민]|{성우}\\ \r\n  사쿠비트릴   발사르탄 ");
    expect(keywords).toEqual(["엔트레스토", "script홍길동/script", "홍길동", "지민", "성우", "사쿠비트릴 발사르탄"]);
    for (const keyword of keywords) expect(keyword).not.toMatch(/[<>\r\n]/);
  });

  it("caps keyword count and length", () => {
    const many = Array.from({ length: 150 }, (_, index) => `용어${index}`).join(",");
    expect(stt.extractKeywords(many)).toHaveLength(100);
    expect(stt.extractKeywords(many, 50)).toHaveLength(50);
    expect([...stt.extractKeywords("가".repeat(80))[0]]).toHaveLength(50);
  });

  it("prices batch and live transcription by the minute", () => {
    expect(stt.transcriptionCost(60_000)).toBeCloseTo(0.0045, 10);
    expect(stt.transcriptionCost(30_000)).toBeCloseTo(0.00225, 10);
    expect(stt.transcriptionCost(-5)).toBe(0);
    expect(stt.liveTranscriptionCost(60_000)).toBeCloseTo(0.017, 10);
  });
});

describe("prepareAudio", () => {
  it("requires FFmpeg for FLAC, falls back to the original WAV, and never touches the source", async () => {
    await expect(stt.prepareAudio(path.join(tempDir, "missing.wav"), null)).rejects.toThrow(/없습니다/);
    const flac = path.join(tempDir, "chunk.flac");
    fs.writeFileSync(flac, "fLaC");
    await expect(stt.prepareAudio(flac, null)).rejects.toThrow(/FFmpeg/);
    const fallback = await stt.prepareAudio(wavPath, null);
    expect(fallback).toMatchObject({ filePath: wavPath, normalized: false });
    fallback.cleanup();
    expect(fs.existsSync(wavPath)).toBe(true);
  });

  it.runIf(Boolean(realFfmpeg))("normalizes to a temporary 16 kHz WAV and removes it on cleanup", async () => {
    const before = fs.readFileSync(wavPath);
    const prepared = await stt.prepareAudio(wavPath, realFfmpeg);
    expect(prepared.normalized).toBe(true);
    expect(prepared.filePath).not.toBe(wavPath);
    const output = fs.readFileSync(prepared.filePath);
    expect(output.subarray(0, 4).toString()).toBe("RIFF");
    expect(output.readUInt32LE(24)).toBe(16_000);
    prepared.cleanup();
    expect(fs.existsSync(prepared.filePath)).toBe(false);
    expect(fs.readFileSync(wavPath).equals(before)).toBe(true);
  });
});

describe("transcribeAudio", () => {
  it("posts multipart gpt-transcribe with Korean, the prompt and filtered keywords", async () => {
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await stt.transcribeAudio({
      apiKey: "sk-test-fixture", filePath: wavPath, durationMs: 30_000,
      glossary: "엔트레스토\n<b>성우</b>", prompt: "한국어 회의입니다. 직전 발언: 안녕하세요"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test-fixture" });
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.getAll("languages[]")).toEqual(["ko"]);
    expect(form.get("prompt")).toBe("한국어 회의입니다. 직전 발언: 안녕하세요");
    expect(form.getAll("keywords[]")).toEqual(["엔트레스토", "b성우/b"]);
    for (const keyword of form.getAll("keywords[]")) expect(String(keyword)).not.toMatch(/[<>\n]/);
    const file = form.get("file") as File;
    expect(file.name).toBe("chunk.wav");
    expect(file.type).toBe("audio/wav");
    expect(Buffer.from(await file.arrayBuffer()).equals(fs.readFileSync(wavPath))).toBe(true);

    expect(result).toMatchObject({ provider: "openai", model: "gpt-transcribe", text: "다음 회의는 금요일입니다.", inputUnits: 0.5, outputUnits: 0 });
    expect(result.costUsd).toBeCloseTo(0.00225, 10);
    expect(result.metadata).toMatchObject({ languages: ["ko"], keywordsUsed: ["엔트레스토", "b성우/b"], audioNormalization: { applied: false } });
  });

  it("omits empty prompts and keywords and truncates long prompts", async () => {
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await stt.transcribeAudio({ apiKey: "k", filePath: wavPath, durationMs: 1_000, glossary: "", prompt: "   " });
    let form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.has("prompt")).toBe(false);
    expect(form.has("keywords[]")).toBe(false);
    await stt.transcribeAudio({ apiKey: "k", filePath: wavPath, durationMs: 1_000, glossary: "", prompt: "가".repeat(3_000) });
    form = fetchMock.mock.calls[1][1].body as FormData;
    expect(String(form.get("prompt"))).toHaveLength(2_000);
  });

  it.each([401, 403, 404])("marks %i as terminal and never echoes the provider body", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret transcript and key", { status })));
    const error = await stt.transcribeAudio({ apiKey: "k", filePath: wavPath, durationMs: 1_000, glossary: "", prompt: "" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.terminal).toBe(true);
    expect(error.message).toContain(`OpenAI 전사 ${status}`);
    expect(error.message).not.toContain("secret");
  });

  it.each([429, 500])("keeps %i retryable", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status })));
    const error = await stt.transcribeAudio({ apiKey: "k", filePath: wavPath, durationMs: 1_000, glossary: "", prompt: "" }).catch((caught) => caught);
    expect(error.terminal).toBe(false);
  });
});

describe("queue handling of STT failures", () => {
  let db: (typeof import("../server/db.ts"))["db"];
  let queue: typeof import("../server/queue.ts");
  const eventId = "stt-event";
  const lectureId = "stt-lecture";
  const at = () => new Date().toISOString();
  const chunkRow = (id: string) => db.prepare("SELECT status,attempts,next_attempt_at,error FROM audio_chunks WHERE id=?").get(id) as any;
  function addChunk(id: string, sequence: number) {
    const file = path.join(tempDir, `${id}.wav`);
    fs.writeFileSync(file, pcmToWav(Buffer.alloc(3_200)));
    db.prepare(`INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,wav_path,flac_path,status,attempts,next_attempt_at,error,created_at,updated_at)
      VALUES(?,?,?,?,?,30000,?,'','pending',0,?,'',?,?)`).run(id, lectureId, sequence, sequence * 28_000, sequence * 28_000 + 30_000, file, at(), at(), at());
  }

  beforeAll(async () => {
    ({ db } = await import("../server/db.ts"));
    queue = await import("../server/queue.ts");
    db.prepare("INSERT INTO events(id,title,glossary,consent_confirmed,budget_usd,created_at,updated_at) VALUES(?,?,?,1,0,?,?)").run(eventId, "STT 회의", "엔트레스토", at(), at());
    db.prepare("INSERT INTO lectures(id,event_id,title,status,created_at,updated_at) VALUES(?,?,?,'paused',?,?)").run(lectureId, eventId, "STT 회의", at(), at());
  });
  afterEach(() => { delete process.env.OPENAI_API_KEY; });
  afterAll(() => { db.close(); });

  it("fails a chunk without calling OpenAI when no key is stored", async () => {
    addChunk("no-key", 0);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await queue.runQueueOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunkRow("no-key")).toMatchObject({ status: "failed", attempts: queue.MAX_CHUNK_ATTEMPTS, next_attempt_at: "9999-12-31T23:59:59.999Z" });
    db.prepare("UPDATE audio_chunks SET status='done' WHERE id='no-key'").run();
  });

  it("turns a 401 into a terminal failed chunk that is not retried automatically", async () => {
    process.env.OPENAI_API_KEY = "sk-test-invalid-000000000000";
    addChunk("auth-fail", 1);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await queue.runQueueOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const failed = chunkRow("auth-fail");
    expect(failed).toMatchObject({ status: "failed", attempts: queue.MAX_CHUNK_ATTEMPTS, next_attempt_at: "9999-12-31T23:59:59.999Z" });
    expect(failed.error).toContain("401");
    expect(queue.peekNextQueuedChunkId(lectureId)).toBeUndefined();
    await queue.runQueueOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM billing_reservations").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_ledger").get()).toMatchObject({ n: 0 });

    // Saving a new key (or a manual retry) resets it to pending.
    expect(queue.retryChunk("auth-fail")).toBe(true);
    expect(chunkRow("auth-fail")).toMatchObject({ status: "pending", attempts: 0 });
    db.prepare("UPDATE audio_chunks SET status='done' WHERE id='auth-fail'").run();
  });

  it("backs off and retries a transient 500, then stores the transcript and bills once", async () => {
    process.env.OPENAI_API_KEY = "sk-test-transient-000000000000";
    addChunk("transient", 2);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await queue.runQueueOnce();
    const failed = chunkRow("transient");
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(Date.parse(failed.next_attempt_at)).toBeGreaterThan(Date.now());
    expect(queue.peekNextQueuedChunkId(lectureId)).toBeUndefined();

    db.prepare("UPDATE audio_chunks SET next_attempt_at=? WHERE id='transient'").run(at());
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => okResponse("재시도 성공입니다."));
    vi.stubGlobal("fetch", fetchMock);
    await queue.runQueueOnce();
    expect(chunkRow("transient")).toMatchObject({ status: "done", attempts: 2 });
    const segment = db.prepare("SELECT raw_text,provider,provider_metadata FROM transcript_segments WHERE chunk_id='transient'").get() as any;
    expect(segment).toMatchObject({ raw_text: "재시도 성공입니다.", provider: "openai" });
    expect(JSON.parse(segment.provider_metadata).keywordsUsed).toEqual(["엔트레스토"]);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(String(form.get("prompt"))).toContain("STT 회의");
    const ledger = db.prepare("SELECT model,kind,cost_usd FROM usage_ledger").all() as any[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ model: "gpt-transcribe", kind: "transcription" });
    expect(ledger[0].cost_usd).toBeCloseTo(0.00225, 10);
  });
});
