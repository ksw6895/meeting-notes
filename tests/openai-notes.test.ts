import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-notes-'));
process.env.MEETING_NOTES_DATA_DIR = folder;
process.env.NODE_ENV = 'test';
const KEY = 'sk-test-notes-fixture-0000000000';
process.env.OPENAI_API_KEY = KEY;

const { db, setSetting } = await import('../server/db.ts');
const notes = await import('../server/notes.ts');
const { callOpenAiNote, OPENAI_NOTE_MODELS } = await import('../server/openai-notes.ts');
type NoteContentPart = import('../server/openai-notes.ts').NoteContentPart;
const app = await (await import('../server/app.ts')).buildApp({ staticFiles: false });
let lectureId = '', eventId = '';
const note = { title: '구글 미트 회의', summary: '다음 회의는 금요일입니다.', keyMessages: [{ text: '금요일에 다시 만난다.', timestamps: ['SOURCE:segment'] }], sections: [], uncertainties: [] };
const response = (patch: object = {}) => new Response(JSON.stringify({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(note) }] }],
  usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 100 } },
  ...patch
}));
const context = () => ({ eventId, lectureId, kind: 'live_note' as const });
const ledger = () => db.prepare('SELECT * FROM usage_ledger ORDER BY created_at').all() as any[];
const fetchMock = () => vi.mocked(globalThis.fetch);
const bodies = () => fetchMock().mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

function addSegment(index: number, text = `${index}번째 발언입니다.`) {
  const at = new Date().toISOString();
  db.prepare("INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,wav_path,flac_path,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,30000,'','','done',?,?,?)")
    .run(`chunk-${index}`, lectureId, index, index * 30000, (index + 1) * 30000, at, at, at);
  db.prepare("INSERT INTO transcript_segments(id,lecture_id,chunk_id,start_ms,end_ms,raw_text,override_text,created_at) VALUES(?,?,?,?,?,?,'',?)")
    .run(`seg-${index}`, lectureId, `chunk-${index}`, index * 30000, (index + 1) * 30000, text, at);
}

beforeEach(async () => {
  process.env.OPENAI_API_KEY = KEY;
  notes.resumeNoteRequests(); db.prepare('DELETE FROM events').run();
  setSetting('live_model', 'gpt-6-luna'); setSetting('final_model', 'gpt-6.1-sol');
  const created = await app.inject({ method: 'POST', url: '/api/meetings', payload: { title: 'Meet + Luna', topic: '출시 일정', participants: '성우, 지민', glossary: '엔트레스토', captureMode: 'online' } });
  ({ id: lectureId, eventId } = created.json());
  const at = new Date().toISOString();
  db.prepare("UPDATE lectures SET status='recording',recorded_ms=30000 WHERE id=?").run(lectureId);
  db.prepare("INSERT INTO audio_chunks(id,lecture_id,sequence,start_ms,end_ms,duration_ms,wav_path,flac_path,status,next_attempt_at,created_at,updated_at) VALUES('chunk',?,0,0,30000,30000,'','','done',?,?,?)").run(lectureId, at, at, at);
  db.prepare("INSERT INTO transcript_segments(id,lecture_id,chunk_id,start_ms,end_ms,raw_text,override_text,created_at) VALUES('segment',?,'chunk',0,30000,'다음 회의는 금요일입니다.','',?)").run(lectureId, at);
  vi.stubGlobal('fetch', vi.fn(async () => response()));
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await app.close(); db.close(); fs.rmSync(folder, { recursive: true, force: true }); delete process.env.OPENAI_API_KEY; });

describe('Responses API requests', () => {
  it('uses the configured live and final models with strict schemas, cache keys and OpenAI accounting', async () => {
    await notes.maybeUpdateLiveNote(lectureId, true);
    db.prepare("UPDATE lectures SET status='processing' WHERE id=?").run(lectureId);
    const markdown = await notes.generateMeetingFinal(lectureId);
    expect(markdown).toContain(`#source-${lectureId}-segment`);
    expect(markdown).toContain('# 구글 미트 회의');
    expect(markdown).toContain('참가자: 성우, 지민');
    const calls = fetchMock().mock.calls;
    expect(calls).toHaveLength(2);
    for (const [url, init] of calls) {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    }
    const [liveBody, finalBody] = bodies();
    expect(liveBody).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, store: false, max_output_tokens: 32768, prompt_cache_key: `meeting-${lectureId}`, text: { format: { type: 'json_schema', name: 'meeting_notes', strict: true } } });
    expect(finalBody).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'high' }, prompt_cache_key: `meeting-${lectureId}` });
    for (const body of [liveBody, finalBody]) {
      expect(body.temperature).toBeUndefined();
      const check = (value: any) => { if (!value || typeof value !== 'object') return; if (value.type === 'object') expect(value.additionalProperties).toBe(false); Object.values(value).forEach(check); };
      check(body.text.format.schema);
      expect(body.input[0].role).toBe('developer');
      expect(body.input.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('작업:') });
    }
    expect(finalBody.input.at(-1).content).toContain('구글 미트 회의'); // the live note is passed to the final pass
    expect(ledger()).toHaveLength(2);
    expect(ledger()[0]).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', kind: 'live_note', input_units: 1000, output_units: 200 });
    expect(ledger()[0].cost_usd).toBeCloseTo((800 * .1 + 200 * .01 + 200 * .5) / 1e6, 12);
    expect(ledger()[1]).toMatchObject({ model: 'gpt-6.1-sol', kind: 'final_note' });
    expect(ledger()[1].cost_usd).toBeCloseTo((800 * 2 + 200 * .1 + 200 * 10) / 1e6, 12);
    expect(db.prepare('SELECT status,final_note FROM lectures WHERE id=?').get(lectureId)).toMatchObject({ status: 'complete', final_note: markdown });
    expect(db.prepare('SELECT COUNT(*) AS n FROM billing_reservations').get()).toMatchObject({ n: 0 });
  });

  it('retries a truncated response once at 65536 and bills both attempts', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }))
      .mockResolvedValueOnce(response()));
    await notes.maybeUpdateLiveNote(lectureId, true);
    expect(bodies().map((body) => body.max_output_tokens)).toEqual([32768, 65536]);
    expect(ledger()).toHaveLength(2);
    expect(db.prepare('SELECT finish_reason FROM note_attempts WHERE lecture_id=? ORDER BY id').all(lectureId).map((row: any) => row.finish_reason)).toEqual(['max_output_tokens', 'completed']);
    expect(db.prepare('SELECT analyzed_until_ms FROM lectures WHERE id=?').get(lectureId)).toMatchObject({ analyzed_until_ms: 30000 });
  });

  it('gives up with a retryable error when 65536 tokens are still not enough', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })));
    await expect(notes.maybeUpdateLiveNote(lectureId, true)).rejects.toMatchObject({ retryable: true });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(ledger()).toHaveLength(2);
  });

  it.each([
    { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'blocked' }] }] },
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] },
    { output: [] },
    { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }
  ])('preserves the previous note on refusal, invalid JSON, empty or incomplete output but keeps the billed usage', async (patch) => {
    db.prepare('INSERT INTO live_notes(lecture_id,state_json,updated_at) VALUES(?,?,?)').run(lectureId, JSON.stringify(note), new Date().toISOString());
    vi.stubGlobal('fetch', vi.fn(async () => response(patch)));
    await expect(notes.maybeUpdateLiveNote(lectureId, true)).rejects.toThrow();
    expect((db.prepare('SELECT state_json FROM live_notes WHERE lecture_id=?').get(lectureId) as any).state_json).toBe(JSON.stringify(note));
    expect(db.prepare('SELECT analyzed_until_ms FROM lectures WHERE id=?').get(lectureId)).toMatchObject({ analyzed_until_ms: 0 });
    expect(ledger()).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM billing_reservations').get()).toMatchObject({ n: 0 });
  });

  it('settles at the reserved maximum when a 2xx body cannot be parsed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    await expect(notes.maybeUpdateLiveNote(lectureId, true)).rejects.toThrow('JSON');
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0].cost_usd).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM billing_reservations').get()).toMatchObject({ n: 0 });
  });

  it('does not overwrite a corrected transcript with stale OpenAI results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { db.prepare("UPDATE transcript_segments SET override_text='월요일로 변경합니다.'").run(); return response(); }));
    await expect(notes.maybeUpdateLiveNote(lectureId, true)).rejects.toThrow('교정');
    expect(db.prepare('SELECT * FROM live_notes').all()).toHaveLength(0);
  });

  it.each([[401, false], [429, true], [503, true]])('releases reservations and hides provider bodies on HTTP %i (retryable=%s)', async (status, retryable) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private key and transcript', { status })));
    const error = await notes.maybeUpdateLiveNote(lectureId, true).catch((caught) => caught);
    expect(error.message).toContain(`OpenAI API ${status}`);
    expect(error.message).not.toContain('private');
    expect(error.retryable).toBe(retryable);
    expect(db.prepare('SELECT * FROM billing_reservations').all()).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
  });

  it('refuses unknown models and a missing key before any request', async () => {
    await expect(callOpenAiNote('gpt-6.1-luna', 'x', {}, context(), new AbortController().signal)).rejects.toMatchObject({ retryable: false });
    delete process.env.OPENAI_API_KEY;
    await expect(callOpenAiNote('gpt-6-luna', 'x', {}, context(), new AbortController().signal)).rejects.toThrow('키');
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('accounts for long-context rates and cached tokens without double-counting reasoning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ usage: { input_tokens: 300000, input_tokens_details: { cached_tokens: 100000 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 100 } } })));
    const result = await callOpenAiNote('gpt-6-luna', 'test', { type: 'object', properties: {}, required: [] }, context(), new AbortController().signal);
    expect(result).toMatchObject({ inputTokens: 300000, outputTokens: 200, thoughtTokens: 100 });
    expect(ledger()[0].cost_usd).toBeCloseTo((200000 * .1 + 100000 * .01) * 2 / 1e6 + 200 * .5 * 1.5 / 1e6, 12);
  });

  it('exposes exactly the three priced note models', () => {
    expect(Object.keys(OPENAI_NOTE_MODELS)).toEqual(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol']);
    expect(notes.NOTE_MODEL_IDS).toEqual(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol']);
  });
});

describe('cache-friendly meeting input', () => {
  const lectureRow = () => db.prepare('SELECT l.*,e.glossary FROM lectures l JOIN events e ON e.id=l.event_id WHERE l.id=?').get(lectureId) as any;
  const parts = (message: { content: string | NoteContentPart[] }) => message.content as NoteContentPart[];
  const breakpoints = (input: ReturnType<typeof notes.meetingInput>) =>
    input.map((message, index) => (Array.isArray(message.content) && message.content.some((part) => part.prompt_cache_breakpoint) ? index : -1)).filter((index) => index >= 0);

  beforeEach(() => {
    db.prepare("DELETE FROM transcript_segments WHERE lecture_id=?").run(lectureId);
    db.prepare("DELETE FROM audio_chunks WHERE lecture_id=?").run(lectureId);
  });

  it('puts rules and meeting details first, transcript blocks of ten segments next, and the task last', () => {
    for (let index = 0; index < 12; index += 1) addSegment(index);
    const input = notes.meetingInput(lectureRow(), '작업: 요약');
    expect(input).toHaveLength(4);
    expect(input[0].role).toBe('developer');
    const developer = parts(input[0])[0];
    expect(developer.type).toBe('input_text');
    expect(developer.text.startsWith(notes.MEETING_EDITOR_RULES)).toBe(true);
    expect(developer.text).toContain('제목: Meet + Luna');
    expect(developer.text).toContain('참가자 후보: 성우, 지민');
    expect(developer.text).toContain('자주 나올 이름·용어: 엔트레스토');
    expect(parts(input[1])[0].text.split('\n')).toHaveLength(11);
    expect(parts(input[1])[0].text).toMatch(/^전사 1:\n\[SOURCE:seg-0 @00:00–00:30\] 0번째 발언입니다\./);
    expect(parts(input[2])[0].text).toMatch(/^전사 2:\n\[SOURCE:seg-10 /);
    expect(parts(input[2])[0].text.split('\n')).toHaveLength(3);
    expect(input[3]).toEqual({ role: 'user', content: '작업: 요약' });
    expect(breakpoints(input)).toEqual([0, 1]);
  });

  it('keeps earlier block texts identical as segments are appended and moves the breakpoint to the newest finished block', () => {
    for (let index = 0; index < 12; index += 1) addSegment(index);
    const first = notes.meetingInput(lectureRow(), '작업: 첫 갱신');
    for (let index = 12; index < 21; index += 1) addSegment(index);
    const second = notes.meetingInput(lectureRow(), '작업: 두 번째 갱신');
    expect(second).toHaveLength(5);
    expect(parts(second[0])).toEqual(parts(first[0]));
    expect(parts(second[1])[0].text).toBe(parts(first[1])[0].text);
    expect(parts(second[2])[0].text.startsWith(parts(first[2])[0].text)).toBe(true);
    expect(parts(second[2])[0].text.split('\n')).toHaveLength(11);
    expect(breakpoints(first)).toEqual([0, 1]);
    expect(breakpoints(second)).toEqual([0, 2]);
    expect(parts(second[2])[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
    expect(parts(second[3])[0].prompt_cache_breakpoint).toBeUndefined();

    for (let index = 21; index < 30; index += 1) addSegment(index);
    const exact = notes.meetingInput(lectureRow(), '작업');
    expect(exact).toHaveLength(5);
    expect(breakpoints(exact)).toEqual([0, 3]);
    expect([1, 2].map((index) => parts(exact[index])[0].text)).toEqual([1, 2].map((index) => parts(second[index])[0].text));
  });

  it('marks only the developer prefix while fewer than ten segments exist', () => {
    for (let index = 0; index < 3; index += 1) addSegment(index);
    const input = notes.meetingInput(lectureRow(), '작업');
    expect(input).toHaveLength(3);
    expect(breakpoints(input)).toEqual([0]);
  });

  it('sends the same prefix to OpenAI on successive live refreshes', async () => {
    for (let index = 0; index < 12; index += 1) addSegment(index);
    await notes.maybeUpdateLiveNote(lectureId, true);
    for (let index = 12; index < 15; index += 1) addSegment(index);
    await notes.maybeUpdateLiveNote(lectureId, true);
    const [first, second] = bodies();
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(second.input[0]).toEqual(first.input[0]);
    expect(second.input[1]).toEqual(first.input[1]);
    expect(second.input[2].content[0].text.startsWith(first.input[2].content[0].text)).toBe(true);
    // The previous note sits in the final task message, after every cached block.
    expect(first.input.at(-1).content).toContain('기존 회의록:\n없음');
    expect(second.input.at(-1).content).toContain('구글 미트 회의');
  });
});

describe('live note interval', () => {
  it('waits at least two minutes and at most five', () => {
    expect(notes.liveNoteIntervalMs(0)).toBe(120_000);
    expect(notes.liveNoteIntervalMs(10 * 60_000)).toBe(120_000);
    expect(notes.liveNoteIntervalMs(16 * 60_000)).toBe(120_000);
    expect(notes.liveNoteIntervalMs(24 * 60_000)).toBe(180_000);
    expect(notes.liveNoteIntervalMs(40 * 60_000)).toBe(300_000);
    expect(notes.liveNoteIntervalMs(3 * 3_600_000)).toBe(300_000);
  });

  it('skips an unforced refresh until enough new transcript exists', async () => {
    expect(await notes.maybeUpdateLiveNote(lectureId)).toBe(false);
    expect(fetchMock()).not.toHaveBeenCalled();
    for (let index = 1; index < 4; index += 1) addSegment(index);
    expect(await notes.maybeUpdateLiveNote(lectureId)).toBe(true);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT analyzed_until_ms FROM lectures WHERE id=?').get(lectureId)).toMatchObject({ analyzed_until_ms: 120_000 });
    addSegment(4);
    expect(await notes.maybeUpdateLiveNote(lectureId)).toBe(false);
    expect(await notes.maybeUpdateLiveNote(lectureId, true)).toBe(true);
    expect(await notes.maybeUpdateLiveNote(lectureId, true)).toBe(false);
  });
});
