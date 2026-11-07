import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import * as archiverModule from "archiver";
import { AUDIO_DIR, db, getSetting, getSettingsBase, mapLecture, mapSegment, setSetting } from "./db.ts";
import { acquireAudioWriter, forceCloseAudioWriter, generateLectureFlac, getLectureStorageStats, hasLiveAudioLease, parseAudioPacket, resolveAudioPath } from "./audio.ts";
import { deleteSecret, getSecret, normalizeApiKey, secretSource, setSecret, validateSecret } from "./secrets.ts";
import { NOTE_MODEL_IDS } from "./notes.ts";
import { OPENAI_NOTE_MODELS } from "./openai-notes.ts";
import { getLatestTranscriptContext, kickQueue, retryChunk, wakeQueue } from "./queue.ts";
import { noteJobs, retryNotes } from "./note-jobs.ts";
import { isCaptionMode, type CaptionMode } from "./types.ts";
import { OpenAiLiveRelay } from "./live-stt.ts";
import { STT_MODEL, LIVE_STT_MODEL } from "./stt.ts";
import { clampNumber, formatTimestamp, id, now, safeFilename } from "./utils.ts";

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw Object.assign(new Error(message), { statusCode: 404 });
  return row;
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

async function settingsResponse() {
  const openAiKeyPresent = Boolean(await getSecret("openai"));
  const stored = getSetting("openai_key_status");
  return {
    ...getSettingsBase(),
    openAiKeyPresent,
    openAiKeySource: secretSource(),
    openAiKeyStatus: !openAiKeyPresent ? "missing" : ["valid", "invalid", "unchecked"].includes(stored) ? stored : "unchecked",
    noteModels: Object.entries(OPENAI_NOTE_MODELS).map(([id, model]) => ({ id, label: model.label, inputUsd: model.input, outputUsd: model.output }))
  };
}

function lectureAudioDir(lectureId: string): string {
  const target = path.resolve(AUDIO_DIR, lectureId);
  if (path.dirname(target) !== path.resolve(AUDIO_DIR)) throw Object.assign(new Error("잘못된 오디오 경로입니다."), { statusCode: 400 });
  return target;
}

function removeLectureAudioFiles(lectureId: string): void {
  fs.rmSync(lectureAudioDir(lectureId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function sendFileWithRange(request: FastifyRequest, reply: FastifyReply, filePath: string, contentType: string) {
  const size = fs.statSync(filePath).size;
  reply.header("Content-Type", contentType).header("Accept-Ranges", "bytes");
  const header = request.headers.range;
  if (!header) {
    reply.header("Content-Length", size);
    return reply.send(fs.createReadStream(filePath));
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) {
    reply.header("Content-Range", `bytes */${size}`);
    return reply.code(416).send();
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      reply.header("Content-Range", `bytes */${size}`);
      return reply.code(416).send();
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    reply.header("Content-Range", `bytes */${size}`);
    return reply.code(416).send();
  }
  end = Math.min(end, size - 1);
  reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
  return reply.send(fs.createReadStream(filePath, { start, end }));
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, time: now() }));

  app.get("/api/settings", settingsResponse);

  app.put("/api/settings", async (request, reply) => {
    const body = (request.body || {}) as any;
    for (const field of ["liveModel", "finalModel"]) {
      if (body[field] !== undefined && !NOTE_MODEL_IDS.includes(String(body[field]) as any)) {
        return reply.code(400).send({ error: "지원하지 않는 회의록 모델입니다." });
      }
    }
    // Validate the key before writing anything, so a rejected save changes nothing.
    if (body.openAiKey) normalizeApiKey(String(body.openAiKey));
    if (body.realtimeSttEnabled !== undefined) {
      setSetting("realtime_stt_enabled", [true, "true", "on", 1].includes(body.realtimeSttEnabled) ? "true" : "false");
    }
    if (body.liveModel) setSetting("live_model", String(body.liveModel));
    if (body.finalModel) setSetting("final_model", String(body.finalModel));
    if (body.krwPerUsd !== undefined) setSetting("krw_per_usd", String(clampNumber(body.krwPerUsd, 1450, 500, 5000)));
    if (body.openAiKey) {
      await setSecret("openai", String(body.openAiKey));
      setSetting("openai_key_status", "unchecked");
    }
    if (body.clearOpenAiKey) {
      await deleteSecret("openai");
      setSetting("openai_key_status", "missing");
    }
    wakeQueue();
    for (const row of db.prepare("SELECT id FROM lectures WHERE status!='complete'").all() as any[]) retryNotes(row.id);
    return settingsResponse();
  });

  app.post("/api/settings/validate", async () => {
    const settings = getSettingsBase();
    const models = [...new Set([STT_MODEL, ...(settings.realtimeSttEnabled ? [LIVE_STT_MODEL] : []), settings.liveModel, settings.finalModel])];
    const checks = await Promise.all(models.map((model) => validateSecret("openai", model)));
    const failed = checks.find((check) => check.status !== "valid");
    const result = failed || { status: "valid" as const, message: `키와 모델 ${models.length}개(${models.join(", ")}) 접근을 확인했습니다.` };
    setSetting("openai_key_status", result.status);
    return { results: { openai: result }, settings: await settingsResponse() };
  });

  app.get("/api/lectures/:lectureId", async (request) => {
    const { lectureId } = request.params as any;
    const lecture = mapLecture(requireRow(db.prepare("SELECT * FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다."));
    const segments = (db.prepare("SELECT * FROM transcript_segments WHERE lecture_id=? ORDER BY start_ms").all(lectureId) as any[]).map(mapSegment);
    const bookmarks = (db.prepare("SELECT id,lecture_id AS lectureId,at_ms AS atMs,note,created_at AS createdAt FROM bookmarks WHERE lecture_id=? ORDER BY at_ms").all(lectureId) as any[])
      .map((bookmark) => ({ ...bookmark, sourceSegmentId: (db.prepare("SELECT id FROM transcript_segments WHERE lecture_id=? ORDER BY ABS(start_ms-?) LIMIT 1").get(lectureId, bookmark.atMs) as any)?.id || null }));
    const noteRow = db.prepare("SELECT state_json,updated_at FROM live_notes WHERE lecture_id=?").get(lectureId) as any;
    const chunks = db.prepare("SELECT id,sequence,start_ms AS startMs,end_ms AS endMs,status,error,flac_path AS flacPath,wav_path AS wavPath,next_attempt_at AS nextAttemptAt,attempts FROM audio_chunks WHERE lecture_id=? ORDER BY sequence").all(lectureId);
    const cost = db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS total FROM usage_ledger WHERE lecture_id=?").get(lectureId) as any;
    const storage = getLectureStorageStats(lectureId);
    return { ...lecture, liveRecorder: hasLiveAudioLease(lectureId), noteJobs: noteJobs(lectureId), segments, bookmarks, liveNote: noteRow ? JSON.parse(noteRow.state_json) : null, chunks, costUsd: cost.total, originalAudioPresent: storage.originalBytes > 0, ...storage };
  });

  app.patch("/api/lectures/:lectureId", async (request) => {
    const { lectureId } = request.params as any;
    const current = requireRow(db.prepare("SELECT * FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    const body = (request.body || {}) as any;
    const timestamp = now();
    db.transaction(() => {
      db.prepare(`UPDATE lectures SET title=?,speaker=?,topic=?,
        note_status=CASE WHEN status IN ('complete','processing') THEN 'pending' ELSE note_status END,
        status=CASE WHEN status='complete' THEN 'processing' ELSE status END,updated_at=? WHERE id=?`)
        .run(body.title ?? current.title, body.speaker ?? current.speaker, body.topic ?? current.topic, timestamp, lectureId);
      db.prepare("UPDATE events SET final_note='',updated_at=? WHERE id=?").run(timestamp, current.event_id);
    }).immediate();
    // Like a transcript correction: keep the previous final note visible and regenerate it.
    if (["complete", "processing"].includes(current.status)) retryNotes(lectureId);
    return mapLecture(db.prepare("SELECT * FROM lectures WHERE id=?").get(lectureId) as any);
  });

  app.delete("/api/lectures/:lectureId", async (request, reply) => {
    const { lectureId } = request.params as any;
    const lecture = requireRow(db.prepare("SELECT id,event_id,status FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    if (lecture.status === "recording") throw conflict("녹음을 일시정지하거나 종료한 뒤 회의를 삭제하세요.");
    forceCloseAudioWriter(lectureId);
    // Files first: on Windows a chunk still open in FFmpeg makes removal fail, and the
    // meeting must then stay listed so the user can retry instead of leaving audio behind.
    try { removeLectureAudioFiles(lectureId); }
    catch { throw conflict("음성 파일을 처리하는 중이라 지금은 지울 수 없습니다. 잠시 후 다시 시도하세요."); }
    // A meeting owns its event row, so deleting the event cascades. Records imported from the
    // older lecture app can share one event with other lectures: then remove only this one.
    const siblings = (db.prepare("SELECT COUNT(*) AS n FROM lectures WHERE event_id=? AND id!=?").get(lecture.event_id, lectureId) as { n: number }).n;
    if (siblings) db.prepare("DELETE FROM lectures WHERE id=?").run(lectureId);
    else db.prepare("DELETE FROM events WHERE id=?").run(lecture.event_id);
    return reply.code(204).send();
  });

  app.put("/api/segments/:segmentId/override", async (request) => {
    const { segmentId } = request.params as any;
    const body = (request.body || {}) as any;
    const segment = requireRow(db.prepare("SELECT s.id,s.lecture_id,l.event_id,l.kind FROM transcript_segments s JOIN lectures l ON l.id=s.lecture_id WHERE s.id=?").get(segmentId) as any, "전사 구간을 찾을 수 없습니다.");
    const timestamp = now();
    db.transaction(() => {
      db.prepare("UPDATE transcript_segments SET override_text=? WHERE id=?").run(String(body.text || "").trim(), segmentId);
      if (segment.kind !== 'meeting') db.prepare("DELETE FROM live_notes WHERE lecture_id=?").run(segment.lecture_id);
      db.prepare(`UPDATE lectures SET analyzed_until_ms=0,
        final_note=CASE WHEN kind='meeting' THEN final_note ELSE '' END,
        note_status=CASE WHEN kind='meeting' AND status IN ('complete','processing') THEN 'pending' ELSE note_status END,
        status=CASE WHEN status='complete' THEN 'processing' ELSE status END,updated_at=? WHERE id=?`).run(timestamp, segment.lecture_id);
      db.prepare("UPDATE events SET final_note='',updated_at=? WHERE id=?").run(timestamp, segment.event_id);
    }).immediate();
    if (segment.kind === 'meeting') retryNotes(segment.lecture_id);
    return mapSegment(db.prepare("SELECT * FROM transcript_segments WHERE id=?").get(segmentId) as any);
  });

  app.post("/api/lectures/:lectureId/bookmarks", async (request, reply) => {
    const { lectureId } = request.params as any;
    const lecture = requireRow(db.prepare("SELECT id,recorded_ms FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    const body = (request.body || {}) as any;
    const bookmark = { id: id(), atMs: clampNumber(body.atMs, lecture.recorded_ms, 0, Math.max(0, lecture.recorded_ms)), note: String(body.note || "").trim(), createdAt: now() };
    db.prepare("INSERT INTO bookmarks(id,lecture_id,at_ms,note,created_at) VALUES(?,?,?,?,?)").run(bookmark.id, lectureId, bookmark.atMs, bookmark.note, bookmark.createdAt);
    return reply.code(201).send({ ...bookmark, lectureId });
  });

  app.delete("/api/bookmarks/:bookmarkId", async (request, reply) => {
    db.prepare("DELETE FROM bookmarks WHERE id=?").run((request.params as any).bookmarkId);
    return reply.code(204).send();
  });

  app.post("/api/lectures/:lectureId/retranscribe", async (request) => {
    const { lectureId } = request.params as any;
    const lecture = requireRow(db.prepare("SELECT id,event_id,status FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    if (!["processing", "complete"].includes(lecture.status)) {
      throw conflict("회의를 종료한 뒤에만 전체 재전사를 시작할 수 있습니다.");
    }
    const chunks = db.prepare("SELECT id,wav_path,flac_path FROM audio_chunks WHERE lecture_id=? ORDER BY sequence").all(lectureId) as Array<{ id: string; wav_path: string; flac_path: string }>;
    if (!chunks.length) throw conflict("재전사할 오디오 청크가 없습니다.");
    const missing = chunks.filter((chunk) => {
      const filePath = resolveAudioPath(chunk.wav_path || chunk.flac_path);
      return !filePath || !fs.existsSync(filePath);
    });
    if (missing.length) {
      throw conflict(`${missing.length}개 청크의 오디오 원본이 없어 재전사할 수 없습니다.`);
    }
    const discardedOverrides = (db.prepare("SELECT COUNT(*) AS count FROM transcript_segments WHERE lecture_id=? AND override_text!=''").get(lectureId) as { count: number }).count;
    const timestamp = now();
    db.transaction(() => {
      db.prepare("DELETE FROM transcript_segments WHERE lecture_id=?").run(lectureId);
      db.prepare("DELETE FROM live_notes WHERE lecture_id=?").run(lectureId);
      db.prepare(`UPDATE audio_chunks SET status='pending',attempts=0,next_attempt_at=?,error='',updated_at=? WHERE lecture_id=?`)
        .run(timestamp, timestamp, lectureId);
      db.prepare("UPDATE lectures SET status='processing',note_status='pending',note_error='',analyzed_until_ms=0,final_note='',updated_at=? WHERE id=?")
        .run(timestamp, lectureId);
      db.prepare("UPDATE events SET final_note='',updated_at=? WHERE id=?").run(timestamp, lecture.event_id);
    }).immediate();
    kickQueue();
    retryNotes(lectureId);
    return {
      ok: true,
      resetChunks: chunks.length,
      discardedOverrides,
      model: STT_MODEL,
      warning: discardedOverrides
        ? `${discardedOverrides}개의 사용자 전사 교정이 삭제되었습니다.`
        : "기존 전사와 노트가 무효화되었으며 원본 오디오에서 다시 처리합니다."
    };
  });

  app.post("/api/queue/retry", async () => { wakeQueue(); return { ok: true }; });
  app.post("/api/chunks/:chunkId/retry", async (request) => {
    const { chunkId } = request.params as any;
    requireRow(db.prepare("SELECT id FROM audio_chunks WHERE id=?").get(chunkId) as any, "오디오 청크를 찾을 수 없습니다.");
    if (!retryChunk(chunkId)) throw conflict("완료된 청크는 다시 처리할 수 없습니다.");
    return db.prepare("SELECT id,status,error,next_attempt_at AS nextAttemptAt,attempts FROM audio_chunks WHERE id=?").get(chunkId);
  });

  app.get("/api/audio/chunks/:chunkId", async (request, reply) => {
    const chunk = requireRow(db.prepare("SELECT * FROM audio_chunks WHERE id=?").get((request.params as any).chunkId) as any, "오디오 청크를 찾을 수 없습니다.");
    const filePath = resolveAudioPath(chunk.flac_path || chunk.wav_path);
    if (!filePath || !fs.existsSync(filePath)) return reply.code(404).send({ error: "오디오 파일이 없습니다." });
    return sendFileWithRange(request, reply, filePath, chunk.flac_path ? "audio/flac" : "audio/wav");
  });

  app.get("/api/lectures/:lectureId/audio.zip", async (request, reply) => {
    const { lectureId } = request.params as any;
    const lecture = requireRow(db.prepare("SELECT * FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    const chunks = db.prepare("SELECT sequence,flac_path,wav_path FROM audio_chunks WHERE lecture_id=? ORDER BY sequence").all(lectureId) as any[];
    const ZipArchive = (archiverModule as any).ZipArchive;
    if (typeof ZipArchive !== "function") throw new Error("ZIP 모듈을 초기화하지 못했습니다.");
    const archive = new ZipArchive({ zlib: { level: 1 } });
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(lecture.title))}-chunks.zip`);
    for (const chunk of chunks) {
      const filePath = resolveAudioPath(chunk.flac_path || chunk.wav_path);
      if (filePath && fs.existsSync(filePath)) archive.file(filePath, { name: `${String(chunk.sequence).padStart(5, "0")}${path.extname(filePath)}` });
    }
    void archive.finalize().catch((error: Error) => archive.destroy(error));
    return reply.send(archive);
  });

  app.get("/api/lectures/:lectureId/audio.flac", async (request, reply) => {
    const { lectureId } = request.params as any;
    const lecture = requireRow(db.prepare("SELECT * FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    if (lecture.status === "recording") throw conflict("녹음을 일시정지하거나 종료한 뒤 원본 오디오를 내보내세요.");
    const filePath = await generateLectureFlac(lectureId);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(lecture.title))}-continuous.flac`);
    return sendFileWithRange(request, reply, filePath, "audio/flac");
  });

  app.delete("/api/lectures/:lectureId/audio", async (request, reply) => {
    const { lectureId } = request.params as any;
    const lecture = requireRow(db.prepare("SELECT status FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    if (!["processing", "complete"].includes(lecture.status)) throw conflict("회의를 종료하고 오디오 처리가 끝난 뒤 삭제하세요.");
    const pending = db.prepare("SELECT COUNT(*) AS count FROM audio_chunks WHERE lecture_id=? AND status!='done'").get(lectureId) as { count: number };
    if (pending.count) throw conflict(`아직 ${pending.count}개 오디오 청크가 처리 중이라 삭제할 수 없습니다.`);
    forceCloseAudioWriter(lectureId);
    removeLectureAudioFiles(lectureId);
    db.transaction(() => {
      db.prepare("UPDATE audio_chunks SET wav_path='',flac_path='',updated_at=? WHERE lecture_id=?").run(now(), lectureId);
      db.prepare("DELETE FROM audio_packet_receipts WHERE lecture_id=?").run(lectureId);
    }).immediate();
    return reply.code(204).send();
  });

  app.get("/api/lectures/:lectureId/export/:format", async (request, reply) => {
    const { lectureId, format } = request.params as any;
    if (!["json", "md", "txt"].includes(format)) return reply.code(400).send({ error: "지원하지 않는 내보내기 형식입니다." });
    const lecture = requireRow(db.prepare("SELECT * FROM lectures WHERE id=?").get(lectureId) as any, "회의를 찾을 수 없습니다.");
    const segments = (db.prepare("SELECT * FROM transcript_segments WHERE lecture_id=? ORDER BY start_ms").all(lectureId) as any[]).map(mapSegment) as any[];
    const base = safeFilename(lecture.title);
    if (format === "json") {
      reply.header("Content-Type", "application/json; charset=utf-8").header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(base)}.json`);
      return { lecture: mapLecture(lecture), segments };
    }
    const content = format === "md" && lecture.final_note ? lecture.final_note : segments.map((segment) => `[${formatTimestamp(segment.startMs)}] ${segment.overrideText || segment.rawText}`).join("\n\n");
    reply.header("Content-Type", `${format === "md" ? "text/markdown" : "text/plain"}; charset=utf-8`);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(base)}.${format}`);
    return reply.send(content);
  });

  const activeCaptions = new Map<string, (mode: CaptionMode) => void>();
  app.put("/api/meetings/:lectureId/captions", async (request, reply) => {
    const { lectureId } = request.params as { lectureId: string };
    const mode = (request.body as { mode?: unknown } | null)?.mode;
    if (!isCaptionMode(mode)) return reply.code(400).send({ error: "자막 선택을 확인하세요." });
    const row = requireRow(db.prepare("SELECT status,caption_mode FROM lectures WHERE id=?").get(lectureId) as
      { status: string; caption_mode: CaptionMode } | undefined, "녹음을 찾을 수 없습니다.");
    if (!["draft", "paused", "recording"].includes(row.status)) throw conflict("종료한 녹음의 자막은 바꿀 수 없습니다.");
    if (row.caption_mode !== mode) {
      db.prepare("UPDATE lectures SET caption_mode=?,updated_at=? WHERE id=?").run(mode, now(), lectureId);
      activeCaptions.get(lectureId)?.(mode);
    }
    return { captionMode: mode };
  });

  app.get("/ws/audio/:lectureId", { websocket: true }, (socket, request) => {
    const { lectureId } = request.params as any;
    const lecture = db.prepare(`
      SELECT l.status,l.event_id,l.title,l.topic,e.glossary FROM lectures l JOIN events e ON e.id=l.event_id WHERE l.id=?
    `).get(lectureId) as any;
    if (!lecture || lecture.status !== "recording") {
      socket.close(1008, "Meeting is not recording");
      return;
    }
    let lease: ReturnType<typeof acquireAudioWriter> | undefined;
    let realtimeRelay: Promise<OpenAiLiveRelay | null> | undefined;
    let generation = 0;
    let liveFromSequence = 0;
    let ownerId = "";
    let released = false;
    const sendLocal = (message: object) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };
    const stopCaptions = () => {
      generation++;
      if (realtimeRelay) void realtimeRelay.then((relay) => relay?.stop()).catch(() => undefined);
      realtimeRelay = undefined;
    };
    const selectCaptions = (mode: CaptionMode) => {
      stopCaptions();
      const current = generation;
      sendLocal({ type: "caption_mode", mode });
      if (mode === "off") return;
      realtimeRelay = getSecret("openai").then((apiKey) => {
        if (generation !== current) return null;
        if (!apiKey) {
          sendLocal({ type: "transcript_status", status: "missing_key", message: "OpenAI API 키가 없어 자막 없이 녹음합니다." });
          return null;
        }
        const relay = new OpenAiLiveRelay({
          eventId: lecture.event_id, lectureId, apiKey, glossary: String(lecture.glossary || ""),
          context: `제목: ${lecture.title}. 배경: ${lecture.topic || ""}. 직전 발언: ${getLatestTranscriptContext(lectureId).slice(-300)}`,
          translateTo: mode === "ko" ? "ko" : undefined,
          emit: (message) => { if (generation === current) sendLocal(message); }
        });
        relay.start();
        return relay;
      }).catch(() => {
        if (generation === current) sendLocal({ type: "transcript_status", status: "disabled", message: "실시간 자막을 연결하지 못했습니다. 녹음은 계속됩니다." });
        return null;
      });
    };
    const release = () => {
      if (released) return;
      released = true;
      if (activeCaptions.get(lectureId) === selectCaptions) activeCaptions.delete(lectureId);
      stopCaptions();
      lease?.release();
    };
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      try {
        if (!isBinary) {
          const hello = JSON.parse(String(data));
          if (hello?.type !== "hello" || typeof hello.sessionId !== "string" || !hello.sessionId.trim()) throw new Error("올바른 녹음 hello가 필요합니다.");
          if (lease) throw new Error("녹음 hello는 한 번만 보낼 수 있습니다.");
          ownerId = hello.sessionId.trim();
          lease = acquireAudioWriter(lectureId, ownerId);
          liveFromSequence = Number.isSafeInteger(hello.liveFromSequence) ? Math.max(0, hello.liveFromSequence) : 0;
          activeCaptions.get(lectureId)?.("off");
          activeCaptions.set(lectureId, selectCaptions);
          selectCaptions((db.prepare("SELECT caption_mode FROM lectures WHERE id=?").get(lectureId) as { caption_mode: CaptionMode }).caption_mode);
          sendLocal({ type: "ready", sessionId: ownerId, recordedMs: lease.writer.durationMs });
          return;
        }
        if (!lease) throw new Error("오디오보다 먼저 녹음 hello를 보내야 합니다.");
        const packet = parseAudioPacket(Buffer.from(data));
        const result = lease.writer.appendPacketDurable(packet.sessionId, packet.sequence, packet.pcm);
        sendLocal({ type: "ack", sessionId: packet.sessionId, sequence: packet.sequence, accepted: result.accepted, recordedMs: lease.writer.durationMs });
        // Only this connection's fresh audio feeds the live preview; replayed backlog does not.
        if (result.accepted && realtimeRelay && packet.sessionId === ownerId && packet.sequence >= liveFromSequence) {
          const current = generation;
          void realtimeRelay.then((relay) => { if (generation === current) relay?.forward(packet.pcm); }).catch(() => undefined);
        }
      } catch (error) {
        sendLocal({ type: "error", error: error instanceof Error ? error.message : "오디오 처리 오류" });
        socket.close(1008, "Invalid audio protocol");
      }
    });
    socket.on("close", release);
    socket.on("error", release);
  });
}
