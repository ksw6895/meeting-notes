import { calculateUsageCost, releaseUsage, reserveUsage, settleUsage, settleUsageAtReservation, type UsageKind } from './billing.ts';
import { db } from './db.ts';
import { getSecret } from './secrets.ts';
import { openAiErrorHint } from './stt.ts';
import { now } from './utils.ts';

// Standard tier, ≤272K input tokens. Verified 2026-11-06: https://developers.openai.com/api/docs/pricing
export const OPENAI_NOTE_MODELS = {
  'gpt-6-luna': { label: 'GPT-6 Luna · 빠르고 저렴', input: 0.10, cached: 0.01, output: 0.50 },
  'gpt-6.1-terra': { label: 'GPT-6.1 Terra · 균형', input: 1.00, cached: 0.05, output: 5.00 },
  'gpt-6.1-sol': { label: 'GPT-6.1 Sol · 최고 품질', input: 2.00, cached: 0.10, output: 10.00 }
} as const;
export type NoteModel = keyof typeof OPENAI_NOTE_MODELS;
export const NOTE_MODEL_IDS = Object.keys(OPENAI_NOTE_MODELS) as NoteModel[];
const LONG_CONTEXT_TOKENS = 272_000;

function strictSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, strictSchema(value)]));
  if (schema.type === 'object') result.additionalProperties = false;
  return result;
}

export type NoteContentPart = { type: 'input_text'; text: string; prompt_cache_breakpoint?: { mode: 'explicit' } };
export type NoteInput = string | Array<{ role: 'developer' | 'user'; content: string | NoteContentPart[] }>;

/**
 * `input` may be split into messages so an append-only transcript keeps a stable,
 * cacheable prefix: cached input costs 5-10% of the normal rate.
 */
export async function callOpenAiNote(model: string, input: NoteInput, schema: object,
  context: { eventId: string; lectureId?: string; kind: UsageKind }, signal: AbortSignal, tokenLimit = 32_768): Promise<{ data: unknown; inputTokens: number; outputTokens: number; thoughtTokens: number }> {
  const rates = OPENAI_NOTE_MODELS[model as NoteModel];
  if (!rates) throw Object.assign(new Error('지원하지 않는 회의록 모델입니다. 설정에서 모델을 다시 선택하세요.'), { retryable: false });
  const key = await getSecret('openai');
  if (!key) throw Object.assign(new Error('OpenAI API 키가 없습니다. 설정에서 키를 저장하세요.'), { retryable: false });
  const inputBound = Buffer.byteLength(JSON.stringify(input) + JSON.stringify(schema), 'utf8') + 2048;
  const longBound = inputBound > LONG_CONTEXT_TOKENS;
  const reservation = reserveUsage({ ...context, provider: 'openai', model, ttlMs: 5 * 60_000,
    maxCostUsd: calculateUsageCost(inputBound, tokenLimit, {
      input: rates.input * (longBound ? 2 : 1), output: rates.output * (longBound ? 1.5 : 1)
    }) });
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input, store: false,
        ...(context.lectureId ? { prompt_cache_key: `meeting-${context.lectureId}` } : {}),
        // Live notes are rewritten many times; low effort keeps reasoning tokens (billed as output) small.
        reasoning: { effort: context.kind === 'live_note' ? 'low' : 'high' },
        max_output_tokens: tokenLimit,
        text: { format: { type: 'json_schema', name: 'meeting_notes', strict: true, schema: strictSchema(schema) } }
      }),
      // Final notes on a long meeting with high reasoning can take several minutes.
      signal: AbortSignal.any([AbortSignal.timeout(context.kind === 'live_note' ? 180_000 : 600_000), signal])
    });
  } catch (error) {
    // A timeout may still be billed by OpenAI, so keep the conservative estimate; a shutdown abort was not sent to completion.
    if (signal.aborted) releaseUsage(reservation); else settleUsageAtReservation(reservation);
    throw error;
  }
  if (!response.ok) {
    releaseUsage(reservation);
    // Do not echo provider bodies: they may contain prompts.
    throw Object.assign(new Error(`OpenAI API ${response.status}: ${openAiErrorHint(response.status)}`), { retryable: response.status === 429 || response.status >= 500 });
  }
  let payload: any;
  try { payload = await response.json(); }
  catch { settleUsageAtReservation(reservation); throw new Error('OpenAI 응답을 JSON으로 읽지 못했습니다. 보수적 최대 비용을 기록했습니다.'); }
  const usage = payload.usage;
  const inputTokens = Number(usage?.input_tokens ?? 0), outputTokens = Number(usage?.output_tokens ?? 0);
  if (usage && Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
    const cached = Math.min(inputTokens, Math.max(0, Number(usage.input_tokens_details?.cached_tokens) || 0));
    const long = inputTokens > LONG_CONTEXT_TOKENS;
    const cost = ((inputTokens - cached) * rates.input + cached * rates.cached) * (long ? 2 : 1) / 1_000_000
      + outputTokens * rates.output * (long ? 1.5 : 1) / 1_000_000;
    // output_tokens already includes reasoning tokens.
    settleUsage(reservation, inputTokens, outputTokens, cost);
  } else settleUsageAtReservation(reservation);
  const reason = payload.incomplete_details?.reason || payload.status || 'unknown';
  db.prepare('INSERT INTO note_attempts(lecture_id,model,kind,finish_reason,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(context.lectureId || '', model, context.kind, reason, inputTokens, outputTokens, now());
  if (payload.status === 'incomplete' && reason === 'max_output_tokens') {
    if (tokenLimit < 65_536) return callOpenAiNote(model, input, schema, context, signal, 65_536);
    throw Object.assign(new Error('OpenAI 응답이 출력 한도에서 잘렸습니다. 마지막 정상 회의록을 유지합니다.'), { retryable: true });
  }
  if (payload.status !== 'completed') throw Object.assign(new Error(`OpenAI 회의록 생성을 완료하지 못했습니다 (${payload.status || 'unknown'}).`), { retryable: false });
  const content = (payload.output || []).filter((item: any) => item.type === 'message').flatMap((item: any) => item.content || []);
  if (content.some((part: any) => part.type === 'refusal')) throw Object.assign(new Error('OpenAI가 이 회의록의 생성을 거절했습니다. 원문과 이전 회의록은 보존됩니다.'), { retryable: false });
  const text = content.filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('');
  if (!text) throw new Error('OpenAI가 빈 회의록을 반환했습니다. 이전 결과를 유지합니다.');
  try { return { data: JSON.parse(text), inputTokens, outputTokens, thoughtTokens: Number(usage?.output_tokens_details?.reasoning_tokens ?? 0) }; }
  catch { throw new Error('OpenAI 회의록 JSON이 올바르지 않습니다. 이전 결과를 유지합니다.'); }
}
