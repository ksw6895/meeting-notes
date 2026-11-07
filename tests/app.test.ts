import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dedupeOverlap, pcmToWav } from "../server/utils.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-app-test-"));
process.env.MEETING_NOTES_DATA_DIR = tempDir;
process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY;

let app: Awaited<ReturnType<(typeof import("../server/app.ts"))["buildApp"]>>;
let db: (typeof import("../server/db.ts"))["db"];
let openAudioWriter: (typeof import("../server/audio.ts"))["openAudioWriter"];
let closeAudioWriter: (typeof import("../server/audio.ts"))["closeAudioWriter"];
let lectureId = "";
let otherLectureId = "";

const start = (id: string, payload: object = {}) => app.inject({ method: "POST", url: `/api/meetings/${id}/start`, payload });
const pause = (id: string) => app.inject({ method: "POST", url: `/api/meetings/${id}/pause`, payload: {} });
const finish = (id: string) => app.inject({ method: "POST", url: `/api/meetings/${id}/finish`, payload: {} });

beforeAll(async () => {
  ({ db } = await import("../server/db.ts"));
  ({ openAudioWriter, closeAudioWriter } = await import("../server/audio.ts"));
  const { buildApp } = await import("../server/app.ts");
  app = await buildApp({ staticFiles: false });
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("text and audio utilities", () => {
  it("removes a repeated two-second boundary phrase", () => {
    expect(dedupeOverlap("오늘은 예산 집행 현황을 공유합니다", "집행 현황을 공유합니다 먼저 1분기 실적입니다"))
      .toBe("먼저 1분기 실적입니다");
  });

  it("keeps non-overlapping transcript text", () => {
    expect(dedupeOverlap("이전 문장입니다", "완전히 새로운 문장입니다")).toBe("완전히 새로운 문장입니다");
  });

  it("creates a valid mono 16 kHz PCM WAV header", () => {
    const wav = pcmToWav(Buffer.alloc(32_000));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(40)).toBe(32_000);
  });
});

describe("meeting lifecycle routes", () => {
  it("snapshots the caption default and persists each recording's choice", async () => {
    const create = async () => (await app.inject({method: "POST", url: "/api/meetings", payload: {title: "발표"}})).json();
    const settings = await import("../server/db.ts");
    const original = settings.getSetting("realtime_stt_enabled");
    try {
      settings.setSetting("realtime_stt_enabled","false");
      const first = await create();
      expect(first.captionMode).toBe("off");
      settings.setSetting("realtime_stt_enabled","true");
      expect((await create()).captionMode).toBe("original");
      const change = (mode: string) => app.inject({method:"PUT",url:`/api/meetings/${first.id}/captions`,payload:{mode}});
      expect((await change("ko")).statusCode).toBe(200);
      expect((await change("garbage")).statusCode).toBe(400);
      expect((await app.inject({url:`/api/lectures/${first.id}`})).json().captionMode).toBe("ko");
      db.prepare("UPDATE lectures SET status='complete' WHERE id=?").run(first.id);
      expect((await change("off")).statusCode).toBe(409);
    } finally { settings.setSetting("realtime_stt_enabled",original); }
  });

  it("validates the meeting title and normalizes the capture mode", async () => {
    expect((await app.inject({ method: "POST", url: "/api/meetings", payload: { title: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/meetings", payload: { title: "가".repeat(301) } })).statusCode).toBe(400);

    const created = await app.inject({ method: "POST", url: "/api/meetings", payload: {
      title: "주간 제품 회의", participants: "성우, 지민", topic: "출시 일정", glossary: "엔트레스토", captureMode: "online"
    } });
    expect(created.statusCode).toBe(201);
    const meeting = created.json();
    expect(meeting).toMatchObject({ title: "주간 제품 회의", speaker: "성우, 지민", topic: "출시 일정", kind: "meeting", captureMode: "online", status: "draft", noteStatus: "idle" });
    lectureId = meeting.id;
    const event = db.prepare("SELECT glossary,consent_confirmed,budget_usd FROM events WHERE id=?").get(meeting.eventId) as any;
    expect(event).toMatchObject({ glossary: "엔트레스토", consent_confirmed: 0, budget_usd: 0 });

    const fallback = await app.inject({ method: "POST", url: "/api/meetings", payload: { title: "다른 회의", captureMode: "zoom-native" } });
    expect(fallback.json().captureMode).toBe("room");
    otherLectureId = fallback.json().id;

    const list = await app.inject({ method: "GET", url: "/api/meetings" });
    expect(list.json().map((row: any) => row.id)).toEqual(expect.arrayContaining([lectureId, otherLectureId]));
    expect(list.json()[0]).toHaveProperty("costUsd");
  });

  it("requires recording consent before the first start", async () => {
    const refused = await start(lectureId);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain("녹음");
    expect((await start(lectureId, { consentConfirmed: "yes" })).statusCode).toBe(400);
    expect(db.prepare("SELECT status FROM lectures WHERE id=?").get(lectureId)).toMatchObject({ status: "draft" });
    expect((await start("missing-meeting", { consentConfirmed: true })).statusCode).toBe(404);
  });

  it("enforces start, pause and finish transitions", async () => {
    expect((await pause(lectureId)).statusCode).toBe(409);
    expect((await finish(lectureId)).statusCode).toBe(409);

    const started = await start(lectureId, { consentConfirmed: true, mode: "room" });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: "recording", captureMode: "room" });
    expect(db.prepare("SELECT e.consent_confirmed FROM events e JOIN lectures l ON l.event_id=e.id WHERE l.id=?").get(lectureId))
      .toMatchObject({ consent_confirmed: 1 });

    // A reopened tab may resume the meeting it lost.
    expect((await start(lectureId)).json().status).toBe("recording");
    // Only one meeting records at a time.
    const competing = await start(otherLectureId, { consentConfirmed: true });
    expect(competing.statusCode).toBe(409);
    expect(competing.json().error).toContain("주간 제품 회의");
  });

  it("journals 60 seconds and creates overlapping durable chunks", () => {
    const writer = openAudioWriter(lectureId);
    writer.append(Buffer.alloc(60 * 16_000 * 2));
    closeAudioWriter(lectureId);
    const chunks = db.prepare("SELECT start_ms, end_ms, status, wav_path FROM audio_chunks WHERE lecture_id=? ORDER BY sequence").all(lectureId) as any[];
    expect(chunks).toHaveLength(2);
    expect([chunks[0].start_ms, chunks[0].end_ms]).toEqual([0, 30_000]);
    expect([chunks[1].start_ms, chunks[1].end_ms]).toEqual([28_000, 60_000]);
    expect(chunks.every((chunk) => chunk.status === "pending")).toBe(true);
    expect(fs.existsSync(chunks[0].wav_path)).toBe(true);
    expect(db.prepare("SELECT recorded_ms FROM lectures WHERE id=?").get(lectureId)).toMatchObject({ recorded_ms: 60_000 });
  });

  it("pauses, resumes without re-confirming consent, preserves a transcript override and retries queued work", async () => {
    expect((await pause(lectureId)).json().status).toBe("paused");
    expect((await pause(lectureId)).statusCode).toBe(409);
    expect((await start(lectureId)).json().status).toBe("recording");
    expect((await pause(lectureId)).json().status).toBe("paused");

    const chunk = db.prepare("SELECT id FROM audio_chunks WHERE lecture_id=? ORDER BY sequence LIMIT 1").get(lectureId) as { id: string };
    db.prepare("INSERT INTO transcript_segments(id,lecture_id,chunk_id,start_ms,end_ms,raw_text,override_text,confidence,created_at) VALUES(?,?,?,?,?,?, '',NULL,?)")
      .run("segment-test", lectureId, chunk.id, 0, 30_000, "엔트레스토", new Date().toISOString());
    const override = await app.inject({ method: "PUT", url: "/api/segments/segment-test/override", payload: { text: "엔트레스토(사쿠비트릴/발사르탄)" } });
    expect(override.json()).toMatchObject({ rawText: "엔트레스토", overrideText: "엔트레스토(사쿠비트릴/발사르탄)" });

    db.prepare("UPDATE audio_chunks SET status='failed',attempts=5 WHERE lecture_id=?").run(lectureId);
    await app.inject({ method: "POST", url: "/api/queue/retry", payload: {} });
    const pending = db.prepare("SELECT COUNT(*) AS count FROM audio_chunks WHERE lecture_id=? AND status='pending' AND attempts=0").get(lectureId) as { count: number };
    expect(pending.count).toBe(2);
  });

  it("returns meeting detail and retries a single chunk only when it failed", async () => {
    const detail = await app.inject({ method: "GET", url: `/api/lectures/${lectureId}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body).toMatchObject({ id: lectureId, recordedMs: 60_000, originalAudioPresent: true });
    expect(body.segments).toHaveLength(1);
    expect(body.chunks).toHaveLength(2);
    expect(body).toHaveProperty("noteJobs");
    expect((await app.inject({ method: "GET", url: "/api/lectures/missing-id" })).statusCode).toBe(404);

    const chunkId = body.chunks[1].id;
    expect((await app.inject({ method: "POST", url: `/api/chunks/${chunkId}/retry`, payload: {} })).statusCode).toBe(409);
    db.prepare("UPDATE audio_chunks SET status='failed',attempts=5,error='x' WHERE id=?").run(chunkId);
    const retried = await app.inject({ method: "POST", url: `/api/chunks/${chunkId}/retry`, payload: {} });
    expect(retried.json()).toMatchObject({ status: "pending", attempts: 0, error: "" });
    expect((await app.inject({ method: "POST", url: "/api/chunks/missing/retry", payload: {} })).statusCode).toBe(404);
  });

  it("adds bookmarks clamped to the recorded duration and links them to a segment", async () => {
    const created = await app.inject({ method: "POST", url: `/api/lectures/${lectureId}/bookmarks`, payload: { atMs: 999_999, note: " 결정 " } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ atMs: 60_000, note: "결정", lectureId });
    const detail = (await app.inject({ method: "GET", url: `/api/lectures/${lectureId}` })).json();
    expect(detail.bookmarks[0]).toMatchObject({ atMs: 60_000, sourceSegmentId: "segment-test" });
    expect((await app.inject({ method: "DELETE", url: `/api/bookmarks/${created.json().id}` })).statusCode).toBe(204);
  });

  it("finishes into processing with a pending note and refuses to restart a finished meeting", async () => {
    const finished = await finish(lectureId);
    expect(finished.json()).toMatchObject({ status: "processing", noteStatus: "pending", noteError: "" });
    expect((await finish(lectureId)).statusCode).toBe(409);
    expect((await start(lectureId)).statusCode).toBe(409);
    // With the first meeting finished, the other meeting may record; it cannot be deleted mid-recording.
    expect((await start(otherLectureId, { consentConfirmed: true })).json().status).toBe("recording");
    expect((await app.inject({ method: "DELETE", url: `/api/lectures/${otherLectureId}` })).statusCode).toBe(409);
    expect((await finish(otherLectureId)).json().status).toBe("processing");
  });

  it("forces a note regeneration for a completed meeting through notes/retry", async () => {
    db.prepare("UPDATE lectures SET status='complete',note_status='complete',final_note='# 기존' WHERE id=?").run(lectureId);
    const retry = await app.inject({ method: "POST", url: `/api/meetings/${lectureId}/notes/retry`, payload: { force: true } });
    expect(retry.json()).toEqual({ ok: true });
    expect(db.prepare("SELECT status,note_status FROM lectures WHERE id=?").get(lectureId)).toMatchObject({ status: "processing", note_status: "pending" });
    expect((await app.inject({ method: "POST", url: "/api/meetings/missing/notes/retry", payload: {} })).statusCode).toBe(404);
  });

  it("rejects foreign origins and never exposes secrets in settings", async () => {
    const foreign = await app.inject({ method: "GET", url: "/api/settings", headers: { origin: "https://evil.example" } });
    expect(foreign.statusCode).toBe(403);
    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.headers["cache-control"]).toBe("no-store");
    expect(settings.json()).toMatchObject({ sttModel: "gpt-transcribe", realtimeSttModel: "gpt-live-transcribe", openAiKeyPresent: false, openAiKeySource: "missing", openAiKeyStatus: "missing" });
    expect(settings.json()).not.toHaveProperty("openAiKey");
  });
});
