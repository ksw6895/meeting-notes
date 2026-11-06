import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-exports-test-"));
process.env.MEETING_NOTES_DATA_DIR = tempDir;
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "sk-test-key-never-sent-000000";

let app: Awaited<ReturnType<(typeof import("../server/app.ts"))["buildApp"]>>;
let db: (typeof import("../server/db.ts"))["db"];
let audioDir = "";
let eventId = "";
let lectureId = "";
const stamp = () => new Date().toISOString();
const okNote = () => new Response(JSON.stringify({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ title: "", summary: "개요", keyMessages: [], sections: [], uncertainties: [] }) }] }],
  usage: { input_tokens: 10, output_tokens: 5 }
}), { status: 200 });

function addSegment(id: string, sequence: number, startMs: number, endMs: number, text: string) {
  db.prepare(`INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,wav_path,flac_path,status,attempts,next_attempt_at,error,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'','','done',0,?,'',?,?)`).run(`${id}-chunk`, lectureId, sequence, startMs, endMs, endMs - startMs, stamp(), stamp(), stamp());
  db.prepare(`INSERT INTO transcript_segments(id,lecture_id,chunk_id,start_ms,end_ms,raw_text,override_text,confidence,created_at)
    VALUES(?,?,?,?,?,?,'',NULL,?)`).run(id, lectureId, `${id}-chunk`, startMs, endMs, text, stamp());
}

beforeAll(async () => {
  ({ db, AUDIO_DIR: audioDir } = await import("../server/db.ts"));
  const { buildApp } = await import("../server/app.ts");
  app = await buildApp({ staticFiles: false });
  const meeting = await app.inject({ method: "POST", url: "/api/meetings", payload: { title: "보안·내보내기 회의", participants: "성우" } });
  ({ id: lectureId, eventId } = meeting.json());
  addSegment("first-segment", 0, 0, 30_000, "혈압 120/80입니다.");
});

afterEach(() => { vi.unstubAllGlobals(); });

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
});

describe("usage reservations", () => {
  it("treats a zero budget as unlimited for meetings", async () => {
    const { releaseUsage, reserveUsage } = await import("../server/billing.ts");
    const reservation = reserveUsage({ eventId, lectureId, provider: "openai", model: "gpt-6.1-sol", kind: "final_note", maxCostUsd: 10_000 });
    releaseUsage(reservation);
    expect(db.prepare("SELECT COUNT(*) AS n FROM billing_reservations").get()).toMatchObject({ n: 0 });
  });

  it("still enforces a legacy cap atomically including outstanding reservations", async () => {
    const { BudgetExceededError, reserveUsage, settleUsage } = await import("../server/billing.ts");
    db.prepare("UPDATE events SET budget_usd=0.01 WHERE id=?").run(eventId);
    try {
      const first = reserveUsage({ eventId, lectureId, provider: "openai", model: "gpt-6-luna", kind: "final_note", maxCostUsd: 0.006 });
      expect(() => reserveUsage({ eventId, lectureId, provider: "openai", model: "gpt-6-luna", kind: "final_note", maxCostUsd: 0.005 }))
        .toThrow(BudgetExceededError);
      settleUsage(first, 100, 50, 0.001);
      settleUsage(first, 100, 50, 0.001); // a second settle of the same reservation is a no-op
      const rows = db.prepare("SELECT COUNT(*) AS count,SUM(cost_usd) AS cost FROM usage_ledger WHERE event_id=?").get(eventId) as any;
      expect(rows.count).toBe(1);
      expect(rows.cost).toBeCloseTo(0.001);
    } finally {
      db.prepare("UPDATE events SET budget_usd=0 WHERE id=?").run(eventId);
      db.prepare("DELETE FROM usage_ledger").run();
    }
  });
});

describe("live note requests", () => {
  it("single-flights concurrent live-note requests", async () => {
    db.prepare("UPDATE lectures SET status='recording' WHERE id=?").run(lectureId);
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return okNote();
    });
    vi.stubGlobal("fetch", fetchMock);
    const { maybeUpdateLiveNote } = await import("../server/notes.ts");
    const results = await Promise.all([maybeUpdateLiveNote(lectureId, true), maybeUpdateLiveNote(lectureId, true)]);
    expect(results).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE lectures SET status='paused' WHERE id=?").run(lectureId);
  });
});

describe("source links and markdown", () => {
  it("renders only canonical source IDs, escapes GFM table pipes and drops unsupported content", async () => {
    const { renderFinalMarkdown } = await import("../server/notes.ts");
    const data = {
      title: "노트", summary: "개요",
      keyMessages: [
        { text: "주장", timestamps: ["SOURCE:first-segment @00:00–00:30"] },
        { text: "근거 없는 모델 추정", timestamps: ["SOURCE:invented"] },
        { text: "  ", timestamps: ["SOURCE:first-segment"] }
      ],
      sections: [{
        heading: "할 일", summary: "", points: [],
        tables: [{ title: "할 일", headers: ["할 일", "담당", "기한"], rows: [{ cells: ["A|B", "성우", "금요일\n오전"], timestamps: ["00:10"] }] }]
      }, { heading: "빈 섹션", summary: "상투 문구", points: [], tables: [] }],
      uncertainties: [{ text: "숫자 확인", timestamps: ["SOURCE:first-segment"] }]
    };
    const markdown = renderFinalMarkdown(data, { participants: "성우, 지민", recordedMs: 30_000 }, [{ lectureId, lectureTitle: "보안·내보내기 회의", segmentId: "first-segment", startMs: 0, endMs: 30_000 }]);
    expect(markdown).toContain("# 노트");
    expect(markdown).toContain("> 참가자: 성우, 지민 · 녹음: 00:30");
    expect(markdown).toContain("## 결정 사항");
    expect(markdown).toContain(`- 주장 — [00:00–00:30](#source-${lectureId}-first-segment)`);
    expect(markdown).toContain("| 할 일 | 담당 | 기한 | 근거 |");
    expect(markdown).toContain("A\\|B");
    expect(markdown).toContain("금요일<br>오전");
    expect(markdown).toContain(`[00:00–00:30](#source-${lectureId}-first-segment) |`);
    expect(markdown).toContain("## 확인 필요");
    expect(markdown).not.toContain("근거 없는 모델 추정");
    expect(markdown).not.toContain("빈 섹션");
    expect(markdown).not.toContain("SOURCE:");
  });

  it("omits the participants prefix and defaults the title", async () => {
    const { renderFinalMarkdown } = await import("../server/notes.ts");
    const markdown = renderFinalMarkdown({ title: "", summary: "", keyMessages: [], sections: [], uncertainties: [] }, { participants: "", recordedMs: 3_723_000 }, []);
    expect(markdown.split("\n").slice(0, 3)).toEqual(["# 회의록", "", "> 녹음: 01:02:03"]);
  });

  it("resolves sources by ID first, then by the containing or nearest time range", async () => {
    const { resolveSource } = await import("../server/notes.ts");
    const sources = [
      { lectureId, lectureTitle: "t", segmentId: "a", startMs: 0, endMs: 30_000 },
      { lectureId, lectureTitle: "t", segmentId: "b", startMs: 28_000, endMs: 60_000 }
    ];
    expect(resolveSource("SOURCE:b @00:00", sources)?.segmentId).toBe("b");
    expect(resolveSource("00:10", sources)?.segmentId).toBe("a");
    expect(resolveSource("05:00", sources)?.segmentId).toBe("b");
    expect(resolveSource("no time", sources)).toBeUndefined();
  });
});

describe("audio, exports and deletion", () => {
  it("supports byte ranges, a working Archiver 8 ZIP, and continuous FLAC", async () => {
    const lectureDir = path.join(audioDir, lectureId);
    fs.mkdirSync(lectureDir, { recursive: true });
    const wavPath = path.join(lectureDir, "chunk.wav");
    fs.writeFileSync(wavPath, Buffer.from("0123456789"));
    db.prepare("UPDATE audio_chunks SET wav_path=?,flac_path='' WHERE id='first-segment-chunk'").run(wavPath);
    const url = "/api/audio/chunks/first-segment-chunk";
    const ranged = await app.inject({ method: "GET", url, headers: { range: "bytes=2-5" } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe("bytes 2-5/10");
    expect(ranged.headers["content-type"]).toBe("audio/wav");
    expect(ranged.rawPayload.toString()).toBe("2345");
    const suffix = await app.inject({ method: "GET", url, headers: { range: "bytes=-3" } });
    expect(suffix.rawPayload.toString()).toBe("789");
    const openEnded = await app.inject({ method: "GET", url, headers: { range: "bytes=7-" } });
    expect(openEnded.rawPayload.toString()).toBe("789");
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "items=0-1", "bytes=-"]) {
      const invalid = await app.inject({ method: "GET", url, headers: { range } });
      expect(invalid.statusCode).toBe(416);
      expect(invalid.headers["content-range"]).toBe("bytes */10");
    }
    const whole = await app.inject({ method: "GET", url });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.rawPayload.toString()).toBe("0123456789");

    const zip = await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/audio.zip` });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe("PK");

    fs.writeFileSync(path.join(lectureDir, "recording.pcm"), Buffer.alloc(32_000));
    db.prepare("UPDATE lectures SET status='recording' WHERE id=?").run(lectureId);
    expect((await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/audio.flac` })).statusCode).toBe(409);
    db.prepare("UPDATE lectures SET status='paused',recorded_ms=1000 WHERE id=?").run(lectureId);
    const flac = await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/audio.flac` });
    expect(flac.statusCode).toBe(200);
    expect(flac.headers["content-type"]).toContain("audio/flac");
    expect(flac.rawPayload.subarray(0, 4).toString()).toBe("fLaC");
    const flacRange = await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/audio.flac`, headers: { range: "bytes=0-3" } });
    expect(flacRange.statusCode).toBe(206);
    expect(flacRange.rawPayload.toString()).toBe("fLaC");
  });

  it("exports JSON, plain text with overrides, and Markdown that prefers the final note", async () => {
    db.prepare("UPDATE transcript_segments SET override_text='혈압 130/80입니다.' WHERE id='first-segment'").run();
    const json = await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/export/json` });
    expect(json.json().lecture.id).toBe(lectureId);
    expect(json.json().segments[0]).toMatchObject({ rawText: "혈압 120/80입니다.", overrideText: "혈압 130/80입니다." });
    expect(json.headers["content-disposition"]).toContain(".json");
    const txt = await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/export/txt` });
    expect(txt.headers["content-type"]).toContain("text/plain");
    expect(txt.body).toBe("[00:00] 혈압 130/80입니다.");
    expect((await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/export/md` })).body).toBe("[00:00] 혈압 130/80입니다.");
    db.prepare("UPDATE lectures SET final_note='# 최종 회의록' WHERE id=?").run(lectureId);
    const md = await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/export/md` });
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toBe("# 최종 회의록");
    expect((await app.inject({ method: "GET", url: `/api/lectures/${lectureId}/export/pdf` })).statusCode).toBe(400);
  });

  it("refuses a full retranscription before the meeting ends, then resets every chunk", async () => {
    const early = await app.inject({ method: "POST", url: `/api/lectures/${lectureId}/retranscribe`, payload: {} });
    expect(early.statusCode).toBe(409);
    db.prepare("UPDATE lectures SET status='complete' WHERE id=?").run(lectureId);
    const reset = await app.inject({ method: "POST", url: `/api/lectures/${lectureId}/retranscribe`, payload: {} });
    expect(reset.json()).toMatchObject({ ok: true, resetChunks: 1, discardedOverrides: 1, model: "gpt-transcribe" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_segments WHERE lecture_id=?").get(lectureId)).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT status FROM audio_chunks WHERE lecture_id=?").get(lectureId)).toMatchObject({ status: "pending" });
    expect(db.prepare("SELECT status,final_note FROM lectures WHERE id=?").get(lectureId)).toMatchObject({ status: "processing", final_note: "" });
  });

  it("refuses to delete audio while chunks are pending, then deletes audio without the transcript, then the meeting", async () => {
    expect((await app.inject({ method: "DELETE", url: `/api/lectures/${lectureId}/audio` })).statusCode).toBe(409);
    db.prepare("UPDATE audio_chunks SET status='done' WHERE lecture_id=?").run(lectureId);
    addSegment("kept-segment", 1, 28_000, 60_000, "원문은 남습니다.");
    const audioDelete = await app.inject({ method: "DELETE", url: `/api/lectures/${lectureId}/audio` });
    expect(audioDelete.statusCode).toBe(204);
    expect(fs.existsSync(path.join(audioDir, lectureId))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audio_chunks WHERE lecture_id=? AND (wav_path!='' OR flac_path!='')").get(lectureId)).toMatchObject({ n: 0 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM transcript_segments WHERE lecture_id=?").get(lectureId) as any).count).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/audio/chunks/kept-segment-chunk" })).statusCode).toBe(404);

    const lectureDelete = await app.inject({ method: "DELETE", url: `/api/lectures/${lectureId}` });
    expect(lectureDelete.statusCode).toBe(204);
    expect(db.prepare("SELECT id FROM lectures WHERE id=?").get(lectureId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM events WHERE id=?").get(eventId)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_segments WHERE lecture_id=?").get(lectureId)).toMatchObject({ n: 0 });
    expect((await app.inject({ method: "DELETE", url: `/api/lectures/${lectureId}` })).statusCode).toBe(404);
  });
});
