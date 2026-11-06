import { db, eventCostUsd } from "./db.ts";
import { id, now } from "./utils.ts";

export type UsageProvider = "openai";
export type UsageKind = "transcription" | "live_note" | "final_note" | "event_note";

export interface UsageRates {
  input: number;
  output: number;
}

export interface UsageReservation {
  id: string;
  eventId: string;
  lectureId: string;
  provider: UsageProvider;
  model: string;
  kind: UsageKind;
  reservedUsd: number;
}

export class BudgetExceededError extends Error {
  readonly statusCode = 409;
  readonly code = "BUDGET_EXCEEDED";

  constructor(readonly budgetUsd: number, readonly currentUsd: number, readonly requestedUsd: number) {
    super(`예상 API 비용이 행사 한도 $${budgetUsd.toFixed(2)}를 초과하여 전송하지 않았습니다.`);
    this.name = "BudgetExceededError";
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS billing_reservations (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    lecture_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    reserved_usd REAL NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS billing_reservations_event_idx
    ON billing_reservations(event_id, expires_at);
`);

export function calculateUsageCost(inputUnits: number, outputUnits: number, rates: UsageRates): number {
  return (Math.max(0, inputUnits) / 1_000_000) * rates.input
    + (Math.max(0, outputUnits) / 1_000_000) * rates.output;
}

export function cleanupStaleReservations(at = now()): number {
  return db.prepare("DELETE FROM billing_reservations WHERE expires_at <= ?").run(at).changes;
}

/** Call only after this process has acquired the app's single-instance lock. */
export function clearAllReservations(): number {
  return db.prepare("DELETE FROM billing_reservations").run().changes;
}

export function reservedEventCostUsd(eventId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(reserved_usd), 0) AS total FROM billing_reservations WHERE event_id=? AND expires_at>?")
    .get(eventId, now()) as { total: number };
  return Number(row.total || 0);
}

/**
 * Atomically reserves the conservative maximum cost before an API request.
 * No await occurs inside the SQLite transaction, so concurrent async callers
 * and separate worker paths cannot both spend the same remaining allowance.
 */
export function reserveUsage(input: {
  eventId: string;
  lectureId?: string;
  provider: UsageProvider;
  model: string;
  kind: UsageKind;
  maxCostUsd: number;
  ttlMs?: number;
}): UsageReservation {
  const reservedUsd = Math.max(0, Number(input.maxCostUsd) || 0);
  const reservationId = id();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 10 * 60_000)).toISOString();
  const transaction = db.transaction(() => {
    cleanupStaleReservations(createdAt);
    const event = db.prepare("SELECT budget_usd FROM events WHERE id=?").get(input.eventId) as { budget_usd: number } | undefined;
    if (!event) throw Object.assign(new Error("행사를 찾을 수 없습니다."), { statusCode: 404 });
    const budgetUsd = Number(event.budget_usd);
    const currentUsd = eventCostUsd(input.eventId) + reservedEventCostUsd(input.eventId);
    // Zero explicitly means unlimited for new meetings; old caps still apply.
    if (budgetUsd > 0 && currentUsd + reservedUsd > budgetUsd + Number.EPSILON) {
      throw new BudgetExceededError(budgetUsd, currentUsd, reservedUsd);
    }
    db.prepare(`INSERT INTO billing_reservations(id,event_id,lecture_id,provider,model,kind,reserved_usd,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      reservationId, input.eventId, input.lectureId || "", input.provider, input.model,
      input.kind, reservedUsd, createdAt, expiresAt
    );
  });
  transaction.immediate();
  return {
    id: reservationId,
    eventId: input.eventId,
    lectureId: input.lectureId || "",
    provider: input.provider,
    model: input.model,
    kind: input.kind,
    reservedUsd
  };
}

export function releaseUsage(reservation: UsageReservation): void {
  db.prepare("DELETE FROM billing_reservations WHERE id=?").run(reservation.id);
}

export function settleUsage(
  reservation: UsageReservation,
  inputUnits: number,
  outputUnits: number,
  actualCostUsd: number
): void {
  const timestamp = now();
  db.transaction(() => {
    const exists = db.prepare("SELECT id FROM billing_reservations WHERE id=?").get(reservation.id);
    if (!exists) return;
    db.prepare(`INSERT INTO usage_ledger(id,event_id,lecture_id,provider,model,kind,input_units,output_units,cost_usd,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id(), reservation.eventId, reservation.lectureId, reservation.provider,
      reservation.model, reservation.kind, Math.max(0, inputUnits), Math.max(0, outputUnits),
      Math.max(0, actualCostUsd), timestamp
    );
    db.prepare("DELETE FROM billing_reservations WHERE id=?").run(reservation.id);
  }).immediate();
}

/** A 2xx response can be billable even if its body cannot be parsed. */
export function settleUsageAtReservation(reservation: UsageReservation): void {
  settleUsage(reservation, 0, 0, reservation.reservedUsd);
}

cleanupStaleReservations();
