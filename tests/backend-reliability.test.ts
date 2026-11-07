import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { dedupeOverlap } from "../server/utils.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-reliability-"));
process.env.MEETING_NOTES_DATA_DIR = tempDir;
process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY;

let db: (typeof import("../server/db.ts"))["db"];
let audio: typeof import("../server/audio.ts");
let queue: typeof import("../server/queue.ts");
let acquireInstanceLock: (typeof import("../server/instance-lock.ts"))["acquireInstanceLock"];
const eventId = "reliability-event";
const lectureOne = "reliability-lecture-one";
const lectureTwo = "reliability-lecture-two";

function makePacket(sessionId: string, sequence: number, pcm = Buffer.alloc(32_000, 1)): Buffer {
  const session = Buffer.from(sessionId);
  const packet = Buffer.alloc(10 + session.length + pcm.length);
  packet.write("LN01", 0, "ascii");
  packet.writeUInt16BE(session.length, 4);
  packet.writeUInt32BE(sequence, 6);
  session.copy(packet, 10);
  pcm.copy(packet, 10 + session.length);
  return packet;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

/** Buffers every JSON message so asynchronous status messages cannot be dropped between awaits. */
function collector(socket: WebSocket) {
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  return {
    messages,
    async next(type: string): Promise<any> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no ${type} message; got ${JSON.stringify(messages)}`);
    }
  };
}

beforeAll(async () => {
  ({ db } = await import("../server/db.ts"));
  audio = await import("../server/audio.ts");
  queue = await import("../server/queue.ts");
  ({ acquireInstanceLock } = await import("../server/instance-lock.ts"));
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO events(id,title,organization,topic,glossary,consent_confirmed,status,final_note,budget_usd,created_at,updated_at)
    VALUES(?,?,?,?,?,1,'active','',15,?,?)`).run(eventId, "신뢰성 회의", "팀", "", "", timestamp, timestamp);
  const insertLecture = db.prepare(`INSERT INTO lectures(id,event_id,title,speaker,topic,status,recorded_ms,analyzed_until_ms,final_note,created_at,updated_at)
    VALUES(?,?,?,'','','recording',0,0,'',?,?)`);
  insertLecture.run(lectureOne, eventId, "첫 회의", timestamp, timestamp);
  insertLecture.run(lectureTwo, eventId, "둘째 회의", timestamp, timestamp);
});

afterAll(async () => {
  audio.forceCloseAllAudioWriters();
  await queue.stopQueueWorker();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("overlap context and boundary cleanup", () => {
  it("removes an overlap after a short model-generated bridge", () => {
    expect(dedupeOverlap(
      "SGLT2 억제제를 가능한 조기에 고려합니다",
      "치료를 가능한 조기에 고려합니다 다음으로 용량을 설명합니다"
    )).toBe("다음으로 용량을 설명합니다");
  });

  it("uses a stable partial-boundary prefix but keeps an ordinary repeated drug term", () => {
    expect(dedupeOverlap(
      "두 번째 핵심을 설명했고 세 번째 핵심은 연장",
      "세 번째 핵심은 연자의 유보 표현입니다"
    )).toBe("연자의 유보 표현입니다");
    expect(dedupeOverlap(
      "이 환자에게 아픽사반을 사용합니다",
      "아픽사반 용량은 5밀리그램입니다"
    )).toBe("아픽사반 용량은 5밀리그램입니다");
  });
});

describe("durable audio packet journal", () => {
  it("parses LN01 and persists a replayed packet only once", () => {
    const packet = makePacket("session-a", 7);
    const parsed = audio.parseAudioPacket(packet);
    expect(parsed.sessionId).toBe("session-a");
    expect(parsed.sequence).toBe(7);
    expect(parsed.pcm).toHaveLength(32_000);

    const first = audio.acquireAudioWriter(lectureOne, "owner-a");
    const reconnect = audio.acquireAudioWriter(lectureOne, "owner-a");
    expect(first.writer.appendPacketDurable(parsed.sessionId, parsed.sequence, parsed.pcm)).toEqual({ accepted: true });
    expect(first.writer.appendPacketDurable(parsed.sessionId, parsed.sequence, parsed.pcm)).toEqual({ accepted: false });
    expect(first.writer.durationMs).toBe(1_000);
    expect(() => audio.acquireAudioWriter(lectureOne, "other-tab")).toThrow(/다른 탭/);
    expect(() => audio.acquireAudioWriter(lectureTwo, "owner-b")).toThrow(/이미 사용 중/);
    first.release();
    expect(audio.hasActiveAudioWriter(lectureOne)).toBe(true);
    reconnect.release();

    const reopened = audio.acquireAudioWriter(lectureOne, "owner-after-restart");
    expect(reopened.writer.appendPacketDurable(parsed.sessionId, parsed.sequence, parsed.pcm)).toEqual({ accepted: false });
    expect(reopened.writer.durationMs).toBe(1_000);
    reopened.release();
    const journal = audio.getLectureJournalPath(lectureOne);
    expect(fs.statSync(journal).size).toBe(32_000);
  });

  it("streams the continuous raw journal to a valid FLAC", async () => {
    const output = await audio.generateLectureFlac(lectureOne);
    expect(fs.readFileSync(output).subarray(0, 4).toString("ascii")).toBe("fLaC");
  });

  it("handles an eight-hour sparse journal without duration or memory overflow", () => {
    const lectureId = "eight-hour-lecture";
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO lectures(id,event_id,title,speaker,topic,status,recorded_ms,analyzed_until_ms,final_note,created_at,updated_at)
      VALUES(?,?,?,'','','paused',0,0,'',?,?)`).run(lectureId, eventId, "8시간 검증", timestamp, timestamp);
    const directory = path.join(tempDir, "audio", lectureId);
    fs.mkdirSync(directory, { recursive: true });
    const expectedBytes = 8 * 60 * 60 * 16_000 * 2;
    const journal = path.join(directory, "recording.pcm");
    fs.writeFileSync(journal, "");
    fs.truncateSync(journal, expectedBytes);
    db.prepare(`INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,wav_path,flac_path,status,attempts,next_attempt_at,error,created_at,updated_at)
      VALUES('eight-hour-last',?,959,28768000,28800000,32000,'','','done',0,?,'',?,?)`).run(lectureId, timestamp, timestamp, timestamp);
    const lease = audio.acquireAudioWriter(lectureId, "eight-hour-owner");
    expect(lease.writer.durationMs).toBe(28_800_000);
    expect(audio.getLectureStorageStats(lectureId).originalBytes).toBe(expectedBytes);
    lease.release();
  });

  it("ACKs durable websocket packets, dedupes replay, and rejects another tab owner", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = await buildApp({ staticFiles: false, port: 0 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("테스트 포트를 열지 못했습니다.");
    const url = `ws://127.0.0.1:${address.port}/ws/audio/${lectureOne}`;
    const primary = new WebSocket(url);
    const primaryInbox = collector(primary);
    await opened(primary);
    primary.send(JSON.stringify({ type: "hello", sessionId: "browser-owner" }));
    expect(await primaryInbox.next("ready")).toMatchObject({ type: "ready", sessionId: "browser-owner" });
    // Realtime preview is enabled by default but no key exists: the relay never connects anywhere.
    expect(await primaryInbox.next("transcript_status")).toMatchObject({ status: "missing_key" });

    const competing = new WebSocket(url);
    const competingInbox = collector(competing);
    await opened(competing);
    competing.send(JSON.stringify({ type: "hello", sessionId: "other-browser" }));
    expect(await competingInbox.next("error")).toMatchObject({ type: "error" });

    const replay = makePacket("old-indexeddb-session", 99);
    primary.send(replay);
    expect(await primaryInbox.next("ack")).toMatchObject({ sessionId: "old-indexeddb-session", sequence: 99, accepted: true });
    primary.send(replay);
    expect(await primaryInbox.next("ack")).toMatchObject({ sessionId: "old-indexeddb-session", sequence: 99, accepted: false });

    competing.close();
    primary.close();
    await new Promise((resolve) => primary.once("close", resolve));
    for (let attempt = 0; attempt < 100 && audio.hasActiveAudioWriter(lectureOne); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(audio.hasActiveAudioWriter(lectureOne)).toBe(false);
    await app.close();
  });

  it("switches captions on one recording socket and keeps every original PCM packet", async () => {
    const { buildApp } = await import("../server/app.ts");
    const { OpenAiLiveRelay } = await import("../server/live-stt.ts");
    const app = await buildApp({ staticFiles: false, port: 0 });
    const id = "caption-switch";
    db.prepare("INSERT INTO lectures(id,event_id,title,status,created_at,updated_at) VALUES(?,?,?,'recording','x','x')").run(id,eventId,id);
    const start = vi.spyOn(OpenAiLiveRelay.prototype,"start").mockImplementation(() => {});
    const forwarded = vi.spyOn(OpenAiLiveRelay.prototype,"forward").mockImplementation(() => {});
    const stop = vi.spyOn(OpenAiLiveRelay.prototype,"stop").mockResolvedValue();
    vi.stubEnv("OPENAI_API_KEY","test-never-sent");
    let socket: WebSocket | undefined;
    try {
      await app.listen({host:"127.0.0.1",port:0});
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/audio/${id}`);
      const inbox = collector(socket);
      await opened(socket);
      socket.send(JSON.stringify({type:"hello",sessionId:"capture",liveFromSequence:1}));
      expect(await inbox.next("caption_mode")).toMatchObject({mode:"original"});
      await inbox.next("ready");
      const originals: Buffer[] = [];
      const packet = async () => {
        const sequence = originals.length;
        const pcm = Buffer.alloc(32000,sequence+1);
        originals.push(pcm);
        socket!.send(makePacket("capture",sequence,pcm));
        expect(await inbox.next("ack")).toMatchObject({sequence,accepted:true});
      };
      const change = async (mode: string) => {
        expect((await app.inject({method:"PUT",url:`/api/meetings/${id}/captions`,payload:{mode}})).statusCode).toBe(200);
        expect(await inbox.next("caption_mode")).toMatchObject({mode});
      };
      await packet(); // Missed while the browser was reconnecting: save it without live replay.
      await packet();
      await change("ko");
      await packet();
      await change("off");
      await packet();
      await change("ko");
      await packet();
      expect(start).toHaveBeenCalledTimes(3);
      expect(stop).toHaveBeenCalledTimes(2);
      expect(forwarded.mock.calls.map(([pcm])=>pcm[0])).toEqual([2,3,5]);
      expect(new Set(forwarded.mock.contexts).size).toBe(3);
      const bytes = fs.readFileSync(path.join(tempDir,"audio",id,"recording.pcm"));
      expect(bytes.equals(Buffer.concat(originals))).toBe(true);
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) {
        const closed = new Promise(resolve => socket!.once("close",resolve));
        socket.close(); await closed;
      }
      await app.close();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it("refuses a websocket for a meeting that is not recording and rejects audio before hello", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = await buildApp({ staticFiles: false, port: 0 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("테스트 포트를 열지 못했습니다.");
    db.prepare("UPDATE lectures SET status='paused' WHERE id=?").run(lectureTwo);
    const refused = new WebSocket(`ws://127.0.0.1:${address.port}/ws/audio/${lectureTwo}`);
    const code = await new Promise<number>((resolve) => refused.once("close", (closeCode) => resolve(closeCode)));
    expect(code).toBe(1008);

    const noHello = new WebSocket(`ws://127.0.0.1:${address.port}/ws/audio/${lectureOne}`);
    const inbox = collector(noHello);
    const closed = new Promise<number>((resolve) => noHello.once("close", (closeCode) => resolve(closeCode)));
    await opened(noHello);
    noHello.send(makePacket("no-hello", 1));
    expect((await inbox.next("error")).error).toContain("hello");
    expect(await closed).toBe(1008);
    await app.close();
  });
});

describe("queue restart and terminal failure recovery", () => {
  it("pauses a stale recording state even when no websocket journal was opened", () => {
    db.prepare("UPDATE lectures SET status='recording' WHERE id=?").run(lectureTwo);
    audio.recoverAudioJournals();
    expect(db.prepare("SELECT status FROM lectures WHERE id=?").get(lectureTwo)).toMatchObject({ status: "paused" });
  });

  it("uses raw text when override is empty and the override when present", () => {
    const chunk = db.prepare("SELECT id FROM audio_chunks WHERE lecture_id=? ORDER BY sequence LIMIT 1").get(lectureOne) as { id: string };
    db.prepare(`INSERT INTO transcript_segments(id,lecture_id,chunk_id,start_ms,end_ms,raw_text,override_text,confidence,created_at)
      VALUES('context-segment',?,?,0,1000,'원본 문맥','',NULL,?)`).run(lectureOne, chunk.id, new Date().toISOString());
    expect(queue.getLatestTranscriptContext(lectureOne)).toBe("원본 문맥");
    db.prepare("UPDATE transcript_segments SET override_text='사용자 교정 문맥' WHERE id='context-segment'").run();
    expect(queue.getLatestTranscriptContext(lectureOne)).toBe("사용자 교정 문맥");
    db.prepare("UPDATE audio_chunks SET status='done' WHERE id=?").run(chunk.id);
  });

  it("recovers stale processing, terminalizes exhausted work, and lets later work proceed", () => {
    const timestamp = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,wav_path,flac_path,status,attempts,next_attempt_at,error,created_at,updated_at)
      VALUES(?,?,?,0,1000,1000,'','',?,?,?,'',?,?)`);
    insert.run("stale-retry", lectureTwo, 0, "processing", 1, timestamp, timestamp, timestamp);
    insert.run("stale-terminal", lectureTwo, 1, "processing", queue.MAX_CHUNK_ATTEMPTS, timestamp, timestamp, timestamp);
    insert.run("later-pending", lectureTwo, 2, "pending", 0, timestamp, timestamp, timestamp);
    expect(queue.recoverStaleProcessingChunks()).toBe(2);
    expect(db.prepare("SELECT status FROM audio_chunks WHERE id='stale-retry'").get()).toMatchObject({ status: "pending" });
    expect(db.prepare("SELECT status, attempts FROM audio_chunks WHERE id='stale-terminal'").get())
      .toMatchObject({ status: "failed", attempts: queue.MAX_CHUNK_ATTEMPTS });
    db.prepare("UPDATE audio_chunks SET status='done' WHERE id='stale-retry'").run();
    expect(queue.peekNextQueuedChunkId(lectureTwo)).toBe("later-pending");
    expect(queue.wakeQueue()).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT status, attempts FROM audio_chunks WHERE id='stale-terminal'").get())
      .toMatchObject({ status: "pending", attempts: 0 });
  });

  it("releases the cost reservation when a chunk fails before reaching OpenAI", async () => {
    process.env.OPENAI_API_KEY = "sk-test-local-preflight-only-0000";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      db.prepare("UPDATE audio_chunks SET wav_path='/definitely/missing/meeting.wav' WHERE id='later-pending'").run();
      const chunk = {
        ...(db.prepare("SELECT * FROM audio_chunks WHERE id='later-pending'").get() as Record<string, unknown>),
        event_id: eventId,
        event_title: "신뢰성 회의",
        organization: "팀",
        glossary: "",
        lecture_title: "둘째 회의",
        lecture_topic: ""
      };
      await expect(queue.processChunk(chunk)).rejects.toThrow(/없습니다/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.OPENAI_API_KEY;
      vi.unstubAllGlobals();
    }
    const reservations = db.prepare("SELECT COUNT(*) AS count FROM billing_reservations").get() as { count: number };
    expect(reservations.count).toBe(0);
  });
});

describe("single instance lock", () => {
  it("rejects a live second owner and can be reacquired after release", () => {
    const directory = path.join(tempDir, "lock-test");
    const first = acquireInstanceLock(directory);
    expect(() => acquireInstanceLock(directory)).toThrow(/이미 실행 중/);
    first.release();
    const second = acquireInstanceLock(directory);
    second.release();
  });
});
