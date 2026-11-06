import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-review-test-"));
process.env.MEETING_NOTES_DATA_DIR = tempDir;
process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY;

let app: Awaited<ReturnType<(typeof import("../server/app.ts"))["buildApp"]>>;
let db: (typeof import("../server/db.ts"))["db"];
let audio: typeof import("../server/audio.ts");
let notes: typeof import("../server/notes.ts");

async function createMeeting(title: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/meetings", payload: { title } });
  return response.json().id;
}

beforeAll(async () => {
  ({ db } = await import("../server/db.ts"));
  audio = await import("../server/audio.ts");
  notes = await import("../server/notes.ts");
  app = await buildAppForTest();
});

async function buildAppForTest() {
  const { buildApp } = await import("../server/app.ts");
  return buildApp({ staticFiles: false });
}

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("fixes from the pre-release review", () => {
  it("rejects requests whose Host is not localhost (DNS rebinding)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/meetings", headers: { host: "attacker.example:4310" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/meetings", headers: { host: "127.0.0.1:4310" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/meetings", headers: { host: "localhost:4310" } })).statusCode).toBe(200);
  });

  it("refuses to pause or finish a meeting another tab is still streaming", async () => {
    const id = await createMeeting("다른 탭");
    expect((await app.inject({ method: "POST", url: `/api/meetings/${id}/start`, payload: { consentConfirmed: true } })).statusCode).toBe(200);
    const lease = audio.acquireAudioWriter(id, "other-tab");
    expect((await app.inject({ method: "GET", url: `/api/lectures/${id}` })).json().liveRecorder).toBe(true);
    expect((await app.inject({ method: "POST", url: `/api/meetings/${id}/start`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/meetings/${id}/pause`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/meetings/${id}/finish`, payload: {} })).statusCode).toBe(409);
    lease.release();
    expect((await app.inject({ method: "POST", url: `/api/meetings/${id}/finish`, payload: {} })).statusCode).toBe(200);
  }, 15_000);

  it("regenerates the final note after a finished meeting is renamed", async () => {
    const id = await createMeeting("이름 변경");
    db.prepare("UPDATE lectures SET status='complete',note_status='complete',final_note='# 이전' WHERE id=?").run(id);
    await app.inject({ method: "PATCH", url: `/api/lectures/${id}`, payload: { title: "새 이름" } });
    const row = db.prepare("SELECT status,note_status FROM lectures WHERE id=?").get(id) as any;
    expect(row).toEqual({ status: "processing", note_status: "pending" });
  });

  it("does not let an exhausted chunk block the final note", async () => {
    const id = await createMeeting("실패 구간");
    const insert = db.prepare(`INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,30000,?,?,'9999','x','x')`);
    insert.run(`${id}-a`, id, 0, 0, 30_000, "done", 1);
    insert.run(`${id}-b`, id, 1, 28_000, 58_000, "failed", 5);
    expect(notes.unfinishedChunkCount(id)).toBe(0);
    insert.run(`${id}-c`, id, 2, 56_000, 86_000, "failed", 2);
    expect(notes.unfinishedChunkCount(id)).toBe(1);
    insert.run(`${id}-d`, id, 3, 84_000, 114_000, "pending", 0);
    expect(notes.unfinishedChunkCount(id)).toBe(2);
  });

  it("finds chunk audio again after the data folder was moved", () => {
    const dir = path.join(audio.getLectureJournalPath("moved").replace(/recording\.pcm$/, ""));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "00000-x.wav");
    fs.writeFileSync(file, "x");
    expect(audio.resolveAudioPath(path.join("/old/place/audio/moved", "00000-x.wav"))).toBe(file);
    expect(audio.resolveAudioPath("/nowhere/else/missing.wav")).toBe("/nowhere/else/missing.wav");
    expect(audio.resolveAudioPath("")).toBe("");
  });

  it("keeps settings unchanged when the submitted key is malformed", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    const response = await app.inject({ method: "PUT", url: "/api/settings", payload: { liveModel: "gpt-6-luna", openAiKey: "not a key" } });
    expect(response.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().liveModel).toBe(before.liveModel);
  });

  it("stores data outside the repository by default", async () => {
    const { defaultDataDir } = await import("../server/db.ts");
    const dir = defaultDataDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.startsWith(path.resolve(import.meta.dirname, ".."))).toBe(false);
  });
});
