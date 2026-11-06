import { db } from './db.ts';
import { cancelNoteRequests, resumeNoteRequests, generateMeetingFinal, liveNoteIntervalMs, maybeUpdateLiveNote, unfinishedChunkCount } from './notes.ts';
import { now } from './utils.ts';

db.exec(`CREATE TABLE IF NOT EXISTS note_jobs (
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle', attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY(lecture_id,kind)
)`);
let timer: NodeJS.Timeout | undefined;
let stopping = false;
const flights = new Map<string, Promise<void>>();
export function noteJobs(lectureId: string) { return db.prepare('SELECT kind,state,attempts,retry_at AS retryAt,error,updated_at AS updatedAt FROM note_jobs WHERE lecture_id=?').all(lectureId); }
export function retryNotes(lectureId: string) {
  db.prepare("UPDATE note_jobs SET state='idle',attempts=0,retry_at='',error='' WHERE lecture_id=?").run(lectureId);
  db.prepare("UPDATE lectures SET note_status=CASE WHEN status='processing' THEN 'pending' ELSE note_status END,note_error='' WHERE id=?").run(lectureId);
  if (timer) tickNotes();
}
function launch(lectureId: string, kind: 'live' | 'final') {
  if (flights.has(lectureId)) return;
  const prior = db.prepare('SELECT * FROM note_jobs WHERE lecture_id=? AND kind=?').get(lectureId,kind) as any;
  if (prior?.state === 'error' || (prior?.retry_at && prior.retry_at > now())) return;
  const attempts = (prior?.attempts || 0) + 1;
  db.prepare(`INSERT INTO note_jobs(lecture_id,kind,state,attempts,updated_at) VALUES(?,?,'updating',?,?)
    ON CONFLICT(lecture_id,kind) DO UPDATE SET state='updating',attempts=excluded.attempts,updated_at=excluded.updated_at`).run(lectureId,kind,attempts,now());
  if (kind === 'final') db.prepare("UPDATE lectures SET note_status='generating',note_error='' WHERE id=?").run(lectureId);
  const flight = (async () => {
    try {
      if (kind === 'final') await generateMeetingFinal(lectureId);
      else await maybeUpdateLiveNote(lectureId, true);
      db.prepare("UPDATE note_jobs SET state='idle',attempts=0,error='',retry_at='',updated_at=? WHERE lecture_id=? AND kind=?").run(now(),lectureId,kind);
      if (kind === 'final') db.prepare("UPDATE lectures SET note_status='complete',note_error='' WHERE id=?").run(lectureId);
    } catch (error: any) {
      if (stopping) {
        db.prepare("UPDATE note_jobs SET state='idle',attempts=MAX(0,attempts-1),retry_at='',error='',updated_at=? WHERE lecture_id=? AND kind=?").run(now(),lectureId,kind);
        if (kind === 'final') db.prepare("UPDATE lectures SET note_status='pending',note_error='' WHERE id=?").run(lectureId);
        return;
      }
      const message = String(error.message || error).slice(0,1000);
      // Outages and 429s back off for minutes. Live notes keep retrying for the whole meeting;
      // only errors that cannot fix themselves (bad key, refusal, conflicts) stop them.
      const permanent = error.retryable === false || [400,401,403,409].includes(error.statusCode);
      const terminal = permanent || (kind === 'final' && attempts >= 6);
      const retryAt = terminal ? '' : new Date(Date.now() + Math.min(5 * 60_000, 15_000 * 2 ** (attempts - 1))).toISOString();
      db.prepare("UPDATE note_jobs SET state=?,error=?,retry_at=?,updated_at=? WHERE lecture_id=? AND kind=?").run(terminal?'error':'retrying',message,retryAt,now(),lectureId,kind);
      if (kind === 'final') db.prepare('UPDATE lectures SET note_status=?,note_error=? WHERE id=?').run(terminal?'error':'pending',message,lectureId);
      console.error(`[note:${kind}] ${lectureId}: ${message}`);
    }
  })().finally(() => flights.delete(lectureId));
  flights.set(lectureId,flight);
}
export function tickNotes() {
  if (stopping) return;
  // Independent from STT: note latency never blocks the next audio chunk.
  const rows = db.prepare(`SELECT l.*,COALESCE(MAX(s.end_ms),0) AS newest FROM lectures l
    LEFT JOIN transcript_segments s ON s.lecture_id=l.id
    WHERE (l.kind='meeting' OR l.status='recording') AND l.status IN ('recording','paused','processing') GROUP BY l.id ORDER BY l.updated_at DESC`).all() as any[];
  for (const row of rows) {
    if (flights.size >= 2) break;
    if (flights.has(row.id)) continue;
    if (row.kind === 'meeting' && row.status === 'processing' && ['pending','generating'].includes(row.note_status)) {
      if (!unfinishedChunkCount(row.id)) {
        if (!row.newest) {
          db.prepare("UPDATE lectures SET note_status='error',note_error='아직 받아쓴 내용이 없습니다. 음성 입력과 전사 연결을 확인하세요.' WHERE id=?").run(row.id);
        } else launch(row.id,'final');
      }
    } else if (row.status !== 'processing' && row.newest > row.analyzed_until_ms
      && (row.analyzed_until_ms === 0 || row.newest - row.analyzed_until_ms >= liveNoteIntervalMs(row.newest))) launch(row.id,'live');
  }
}
export function startNoteWorker() {
  if (timer) return;
  stopping = false;
  resumeNoteRequests();
  db.prepare("UPDATE note_jobs SET state='retrying',retry_at='' WHERE state='updating'").run();
  db.prepare("UPDATE lectures SET note_status='pending' WHERE note_status='generating'").run();
  timer = setInterval(tickNotes,1500); timer.unref(); tickNotes();
}
export async function stopNoteWorker() { stopping=true; clearInterval(timer); timer=undefined; cancelNoteRequests(); await Promise.allSettled(flights.values()); }
