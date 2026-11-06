import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-reliability-'));
process.env.MEETING_NOTES_DATA_DIR = folder;
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'sk-test-key-never-sent-000000';
vi.mock('../server/stt.ts', async (original) => ({
  ...await original<typeof import('../server/stt.ts')>(),
  transcribeAudio: vi.fn(async () => ({ provider: 'openai', model: 'gpt-transcribe', text: '다음 회의는 금요일입니다.', confidence: null, inputUnits: 0.5, outputUnits: 0, costUsd: 0.00225, metadata: {} }))
}));
let app: Awaited<ReturnType<(typeof import('../server/app.ts'))['buildApp']>>;
let db: (typeof import('../server/db.ts'))['db'];
let notes: typeof import('../server/notes.ts');
let jobs: typeof import('../server/note-jobs.ts');
let lectureId = '';
const stamp = () => new Date().toISOString();
const validNote = () => ({ title: '검증 회의', summary: '성우가 내일까지 수정합니다.', keyMessages: [{ text: '오류를 수정한다.', timestamps: ['SOURCE:segment-0'] }], sections: [], uncertainties: [] });
const response = () => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(validNote()) }] }],
  usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 } }
}), { status: 200 });
function addChunk(sequence: number, status = 'done') {
  const chunkId = `chunk-${sequence}`;
  db.prepare(`INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,wav_path,flac_path,status,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,30000,'','',?,?,?,?)`).run(chunkId, lectureId, sequence, sequence * 30000, (sequence + 1) * 30000, status, stamp(), stamp(), stamp());
  return chunkId;
}
function row() { return db.prepare('SELECT * FROM lectures WHERE id=?').get(lectureId) as any; }
const job = (kind: string) => (jobs.noteJobs(lectureId) as any[]).find((entry) => entry.kind === kind);
async function settled() { await vi.waitFor(() => expect((jobs.noteJobs(lectureId) as any[]).some((j) => j.state === 'updating')).toBe(false), { timeout: 1000, interval: 5 }); }

beforeAll(async () => {
  ({ db } = await import('../server/db.ts'));
  app = await (await import('../server/app.ts')).buildApp({ staticFiles: false });
  notes = await import('../server/notes.ts'); jobs = await import('../server/note-jobs.ts');
});
beforeEach(async () => {
  notes.resumeNoteRequests();
  db.prepare('DELETE FROM events').run();
  const created = await app.inject({ method: 'POST', url: '/api/meetings', payload: { title: '검증 회의' } });
  lectureId = created.json().id;
  db.prepare("UPDATE lectures SET status='recording',recorded_ms=30000 WHERE id=?").run(lectureId);
  addChunk(0);
  db.prepare("INSERT INTO transcript_segments(id,lecture_id,chunk_id,start_ms,end_ms,raw_text,override_text,created_at) VALUES('segment-0',?,'chunk-0',0,30000,'성우가 내일까지 오류를 수정합니다.','',?)").run(lectureId, stamp());
});
afterEach(async () => { await jobs.stopNoteWorker(); vi.unstubAllGlobals(); });
afterAll(async () => { await app.close(); db.close(); fs.rmSync(folder, { recursive: true, force: true }); delete process.env.OPENAI_API_KEY; });

it('rejects stale final results and preserves the previous final note', async () => {
  db.prepare("UPDATE lectures SET status='processing',final_note='마지막 정상 결과' WHERE id=?").run(lectureId);
  vi.stubGlobal('fetch', vi.fn(async () => { db.prepare("UPDATE transcript_segments SET override_text='담당자는 지민입니다.'").run(); return response(); }));
  await expect(notes.generateMeetingFinal(lectureId)).rejects.toMatchObject({ retryable: true });
  expect(row().final_note).toBe('마지막 정상 결과');
  expect(row().status).toBe('processing');
});

it('requires a finished meeting with every chunk transcribed before the final note', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  await expect(notes.generateMeetingFinal(lectureId)).rejects.toMatchObject({ statusCode: 409 });
  db.prepare("UPDATE lectures SET status='processing' WHERE id=?").run(lectureId);
  addChunk(1, 'pending');
  await expect(notes.generateMeetingFinal(lectureId)).rejects.toThrow(/1개 음성 구간/);
  await expect(notes.generateMeetingFinal('missing')).rejects.toMatchObject({ statusCode: 404 });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it('returns the stored final note without a request unless forced', async () => {
  db.prepare("UPDATE lectures SET status='complete',final_note='# 저장된 결과' WHERE id=?").run(lectureId);
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  expect(await notes.generateMeetingFinal(lectureId)).toBe('# 저장된 결과');
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(await notes.generateMeetingFinal(lectureId, true)).toContain('# 검증 회의');
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

it('automatically retries temporary errors without blocking transcription', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 })).mockResolvedValueOnce(response()));
  jobs.startNoteWorker(); await settled();
  expect(job('live')).toMatchObject({ state: 'retrying', attempts: 1 });
  expect(Date.parse(job('live').retryAt)).toBeGreaterThan(Date.now());
  jobs.tickNotes(); await settled();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // still backing off
  db.prepare("UPDATE note_jobs SET retry_at='' WHERE lecture_id=?").run(lectureId);
  jobs.tickNotes(); await settled(); expect(row().analyzed_until_ms).toBe(30000);
  expect(job('live')).toMatchObject({ state: 'idle', attempts: 0, error: '' });
});

it('stops retrying after an authentication failure until notes are retried manually', async () => {
  db.prepare("UPDATE lectures SET status='processing',note_status='pending' WHERE id=?").run(lectureId);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
  jobs.startNoteWorker(); await settled();
  expect(job('final')).toMatchObject({ state: 'error', attempts: 1 });
  expect(row().note_status).toBe('error');
  expect(row().note_error).toContain('401');
  jobs.tickNotes(); await settled();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

  vi.stubGlobal('fetch', vi.fn(async () => response()));
  const retry = await app.inject({ method: 'POST', url: `/api/meetings/${lectureId}/notes/retry`, payload: {} });
  expect(retry.statusCode).toBe(200);
  await settled();
  await vi.waitFor(() => expect(row().note_status).toBe('complete'), { timeout: 1000, interval: 5 });
  expect(row().status).toBe('complete');
  expect(row().final_note).toContain('# 검증 회의');
});

it('marks a finished meeting without any transcript as a note error instead of calling OpenAI', async () => {
  db.prepare('DELETE FROM transcript_segments WHERE lecture_id=?').run(lectureId);
  db.prepare("UPDATE lectures SET status='processing',note_status='pending' WHERE id=?").run(lectureId);
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  jobs.startNoteWorker(); await settled();
  expect(row().note_status).toBe('error');
  expect(row().note_error).toContain('받아쓴 내용이 없습니다');
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it('waits for pending chunks before generating the final note', async () => {
  db.prepare("UPDATE lectures SET status='processing',note_status='pending' WHERE id=?").run(lectureId);
  addChunk(1, 'pending');
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  jobs.startNoteWorker(); await settled();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(row().note_status).toBe('pending');
  db.prepare("UPDATE audio_chunks SET status='done' WHERE id='chunk-1'").run();
  jobs.tickNotes(); await settled();
  await vi.waitFor(() => expect(row().note_status).toBe('complete'), { timeout: 1000, interval: 5 });
});

it('requeues final generation after a correction while retaining its previous result', async () => {
  db.prepare("UPDATE lectures SET status='complete',note_status='complete',final_note='기존 결과' WHERE id=?").run(lectureId);
  const corrected = await app.inject({ method: 'PUT', url: '/api/segments/segment-0/override', payload: { text: '지민이 금요일까지 수정합니다.' } });
  expect(corrected.statusCode).toBe(200); expect(row().note_status).toBe('pending'); expect(row().final_note).toBe('기존 결과');
  expect(row().status).toBe('processing');
  const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => response());
  vi.stubGlobal('fetch', fetchMock); jobs.startNoteWorker(); await settled();
  await vi.waitFor(() => expect(row().note_status).toBe('complete'), { timeout: 1000, interval: 5 });
  expect(row().status).toBe('complete');
  expect(JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0][1].body)).input)).toContain('지민이 금요일까지 수정합니다.');
});

it('cancels slow generation on shutdown and resumes from durable pending state', async () => {
  db.prepare("UPDATE lectures SET status='processing',note_status='pending' WHERE id=?").run(lectureId);
  const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }); }));
  vi.stubGlobal('fetch', fetchMock); jobs.startNoteWorker();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(row().note_status).toBe('generating');
  const before = Date.now(); await jobs.stopNoteWorker(); expect(Date.now() - before).toBeLessThan(1000);
  expect(row().note_status).toBe('pending'); expect(job('final').attempts).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM billing_reservations').get()).toMatchObject({ n: 0 });
  vi.stubGlobal('fetch', vi.fn(async () => response())); jobs.startNoteWorker(); await settled();
  await vi.waitFor(() => expect(row().status).toBe('complete'), { timeout: 1000, interval: 5 });
});

it('finishes the next STT chunk while a note is still generating', async () => {
  let resolveNote!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveNote = resolve; })));
  const noteFlight = notes.maybeUpdateLiveNote(lectureId, true);
  await vi.waitFor(() => expect(resolveNote).toBeTypeOf('function'));
  const chunkId = addChunk(1, 'pending');
  const chunk = db.prepare(`SELECT c.*,l.event_id,l.title AS lecture_title,l.topic AS lecture_topic,e.title AS event_title,e.organization,e.glossary FROM audio_chunks c JOIN lectures l ON l.id=c.lecture_id JOIN events e ON e.id=l.event_id WHERE c.id=?`).get(chunkId);
  await (await import('../server/queue.ts')).processChunk(chunk);
  expect((db.prepare('SELECT status FROM audio_chunks WHERE id=?').get(chunkId) as any).status).toBe('done');
  expect(db.prepare("SELECT raw_text,provider FROM transcript_segments WHERE chunk_id=?").get(chunkId)).toMatchObject({ raw_text: '다음 회의는 금요일입니다.', provider: 'openai' });
  expect(row().analyzed_until_ms).toBe(0);
  resolveNote(response()); await noteFlight;
  // The note covered only the transcript that existed when it started.
  expect(row().analyzed_until_ms).toBe(30000);
});
