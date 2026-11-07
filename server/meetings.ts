import type { FastifyInstance } from 'fastify';
import { db, defaultCaptionMode, eventCostUsd, mapLecture } from './db.ts';
import { forceCloseAudioWriter, hasLiveAudioLease } from './audio.ts';
import { noteJobs, retryNotes } from './note-jobs.ts';
import { id, now } from './utils.ts';
import { kickQueue } from './queue.ts';

// The browser captures audio (microphone, optionally a shared tab/screen); the server owns state and storage.
export const CAPTURE_MODES = ['room', 'online'] as const;
export type CaptureMode = typeof CAPTURE_MODES[number];
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

/**
 * The tab that just stopped closes its socket right before calling pause/finish, so give the
 * lease a moment to drop. A lease that stays means another tab or browser is still recording.
 */
async function waitForNoLiveRecorder(lectureId: string): Promise<void> {
  for (let i = 0; i < 40 && hasLiveAudioLease(lectureId); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (hasLiveAudioLease(lectureId)) throw conflict('다른 탭이나 창에서 이 회의를 녹음하고 있습니다. 그 창에서 일시정지하거나 종료하세요.');
}

function meetingRow(lectureId: string) {
  const row = db.prepare('SELECT * FROM lectures WHERE id=?').get(lectureId) as any;
  if (!row) throw Object.assign(new Error('회의를 찾을 수 없습니다.'), { statusCode: 404 });
  return row;
}

export async function registerMeetings(app: FastifyInstance) {
  app.get('/api/meetings', async () => (db.prepare(`SELECT l.* FROM lectures l ORDER BY l.created_at DESC`).all() as any[])
    .map((row) => ({ ...mapLecture(row), costUsd: eventCostUsd(row.event_id), liveRecorder: hasLiveAudioLease(row.id) })));

  app.post('/api/meetings', async (request, reply) => {
    const body = (request.body || {}) as any;
    const title = String(body.title || '').trim();
    if (!title || title.length > 300) return reply.code(400).send({ error: '회의 이름을 300자 이내로 입력하세요.' });
    const mode = CAPTURE_MODES.includes(body.captureMode) ? body.captureMode : 'room';
    const eventId = id(), lectureId = id(), timestamp = now();
    db.transaction(() => {
      // Meetings have no spending cap (budget 0 = unlimited); the ledger still records every call.
      db.prepare(`INSERT INTO events(id,title,organization,topic,glossary,consent_confirmed,budget_usd,created_at,updated_at) VALUES(?,?, '',?,?,0,0,?,?)`)
        .run(eventId, title, String(body.topic || ''), String(body.glossary || ''), timestamp, timestamp);
      db.prepare(`INSERT INTO lectures(id,event_id,title,speaker,topic,kind,capture_mode,caption_mode,created_at,updated_at) VALUES(?,?,?,?,?,'meeting',?,?,?,?)`)
        .run(lectureId, eventId, title, String(body.participants || ''), String(body.topic || ''), mode, defaultCaptionMode(), timestamp, timestamp);
    }).immediate();
    return reply.code(201).send(mapLecture(db.prepare('SELECT * FROM lectures WHERE id=?').get(lectureId) as any));
  });

  app.post('/api/meetings/:lectureId/start', async (request, reply) => {
    const body = (request.body || {}) as any, lectureId = (request.params as any).lectureId;
    const row = meetingRow(lectureId);
    const event = db.prepare('SELECT consent_confirmed FROM events WHERE id=?').get(row.event_id) as any;
    if (!event.consent_confirmed && body.consentConfirmed !== true) return reply.code(400).send({ error: '참석자에게 녹음·전사 사실을 알렸는지 확인하세요.' });
    // 'recording' is accepted again so a reopened tab can resume a meeting it lost.
    if (!['draft', 'paused', 'recording'].includes(row.status)) throw conflict('이미 종료된 회의입니다.');
    if (hasLiveAudioLease(lectureId)) throw conflict('다른 탭이나 창에서 이 회의를 이미 녹음하고 있습니다.');
    const other = db.prepare("SELECT title FROM lectures WHERE status='recording' AND id!=?").get(lectureId) as any;
    if (other) throw conflict(`다른 회의 '${other.title}'이(가) 녹음 중입니다. 먼저 일시정지하거나 종료하세요.`);
    const mode = CAPTURE_MODES.includes(body.mode) ? body.mode : row.capture_mode;
    db.transaction(() => {
      db.prepare("UPDATE lectures SET status='recording',capture_mode=?,updated_at=? WHERE id=?").run(mode, now(), lectureId);
      if (body.consentConfirmed) db.prepare('UPDATE events SET consent_confirmed=1 WHERE id=?').run(row.event_id);
    }).immediate();
    return mapLecture(meetingRow(lectureId));
  });

  app.post('/api/meetings/:lectureId/pause', async (request) => {
    const lectureId = (request.params as any).lectureId;
    const row = meetingRow(lectureId);
    if (row.status !== 'recording') throw conflict('녹음 중인 회의가 아닙니다.');
    await waitForNoLiveRecorder(lectureId);
    forceCloseAudioWriter(lectureId);
    db.prepare("UPDATE lectures SET status='paused',updated_at=? WHERE id=?").run(now(), lectureId);
    kickQueue();
    return mapLecture(meetingRow(lectureId));
  });

  app.post('/api/meetings/:lectureId/finish', async (request) => {
    const lectureId = (request.params as any).lectureId;
    const row = meetingRow(lectureId);
    if (!['recording', 'paused'].includes(row.status)) throw conflict('종료할 수 없는 회의 상태입니다.');
    await waitForNoLiveRecorder(lectureId);
    forceCloseAudioWriter(lectureId);
    db.prepare("UPDATE lectures SET status='processing',note_status='pending',note_error='',updated_at=? WHERE id=?").run(now(), lectureId);
    kickQueue();
    return mapLecture(meetingRow(lectureId));
  });

  app.get('/api/meetings/:lectureId/note-jobs', async (request) => noteJobs((request.params as any).lectureId));
  app.post('/api/meetings/:lectureId/notes/retry', async (request, reply) => {
    const lectureId = (request.params as any).lectureId;
    const row = db.prepare('SELECT id,status FROM lectures WHERE id=?').get(lectureId) as any;
    if (!row) return reply.code(404).send({ error: '회의를 찾을 수 없습니다.' });
    if (row.status === 'complete' && (request.body as any)?.force === true) {
      db.prepare("UPDATE lectures SET status='processing',note_status='pending',note_error='',updated_at=? WHERE id=?").run(now(), lectureId);
    }
    retryNotes(lectureId);
    return { ok: true };
  });
}
