import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppSettings } from "./types.ts";

export const ROOT_DIR = path.resolve(import.meta.dirname, "..");
/**
 * Recordings, notes and the API key live in the user's app-data folder, not next to the code:
 * a Desktop/Documents checkout is often OneDrive/iCloud-synced, and a re-clone keeps the data.
 */
export function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "MeetingNotes");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "MeetingNotes");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "meeting-notes");
}
export const DATA_DIR = process.env.MEETING_NOTES_DATA_DIR || defaultDataDir();
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

export const db: BetterSqlite3.Database = new BetterSqlite3(path.join(DATA_DIR, "meeting-notes.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = FULL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    organization TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    glossary TEXT NOT NULL DEFAULT '',
    consent_confirmed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    final_note TEXT NOT NULL DEFAULT '',
    budget_usd REAL NOT NULL DEFAULT 15,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lectures (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    speaker TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    recorded_ms INTEGER NOT NULL DEFAULT 0,
    analyzed_until_ms INTEGER NOT NULL DEFAULT 0,
    final_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audio_chunks (
    id TEXT PRIMARY KEY,
    lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    wav_path TEXT NOT NULL DEFAULT '',
    flac_path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(lecture_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY,
    lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    chunk_id TEXT NOT NULL UNIQUE REFERENCES audio_chunks(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    raw_text TEXT NOT NULL,
    override_text TEXT NOT NULL DEFAULT '',
    confidence REAL,
    provider TEXT NOT NULL DEFAULT '',
    provider_metadata TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS live_notes (
    lecture_id TEXT PRIMARY KEY REFERENCES lectures(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    at_ms INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_ledger (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    lecture_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_units REAL NOT NULL DEFAULT 0,
    output_units REAL NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_queue_idx ON audio_chunks(status, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS segments_lecture_idx ON transcript_segments(lecture_id, start_ms);
  CREATE INDEX IF NOT EXISTS usage_event_idx ON usage_ledger(event_id, created_at);
`);

// Additive migration for databases created before event-scoped budgets existed.
const eventColumns = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
if (!eventColumns.some((column) => column.name === "budget_usd")) {
  db.exec("ALTER TABLE events ADD COLUMN budget_usd REAL NOT NULL DEFAULT 15");
}

const segmentColumns = db.prepare("PRAGMA table_info(transcript_segments)").all() as Array<{ name: string }>;
if (!segmentColumns.some((column) => column.name === "provider")) {
  db.exec("ALTER TABLE transcript_segments ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
}
if (!segmentColumns.some((column) => column.name === "provider_metadata")) {
  db.exec("ALTER TABLE transcript_segments ADD COLUMN provider_metadata TEXT NOT NULL DEFAULT ''");
}

const defaults: Record<string, string> = {
  realtime_stt_enabled: "true",
  live_model: "gpt-6.1-terra",
  final_model: "gpt-6.1-terra",
  budget_usd: "15",
  krw_per_usd: "1450",
  openai_key_status: "missing"
};

const insertSetting = db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);

// Additive upgrade: existing recordings, notes and budgets survive.
const lectureColumns = new Set((db.prepare("PRAGMA table_info(lectures)").all() as Array<{ name: string }>).map((row) => row.name));
for (const [column, definition] of Object.entries({
  kind: "TEXT NOT NULL DEFAULT 'meeting'",
  capture_mode: "TEXT NOT NULL DEFAULT 'room'",
  note_status: "TEXT NOT NULL DEFAULT 'idle'",
  note_error: "TEXT NOT NULL DEFAULT ''"
})) if (!lectureColumns.has(column)) db.exec(`ALTER TABLE lectures ADD COLUMN ${column} ${definition}`);

export function getSetting(key: string): string {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? defaults[key] ?? "";
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getSettingsBase(): Omit<AppSettings, "openAiKeyPresent" | "openAiKeyStatus" | "openAiKeySource"> {
  return {
    sttModel: "gpt-transcribe",
    realtimeSttEnabled: getSetting("realtime_stt_enabled") !== "false",
    realtimeSttModel: "gpt-live-transcribe",
    liveModel: getSetting("live_model"),
    finalModel: getSetting("final_model"),
    budgetUsd: Number(getSetting("budget_usd")),
    krwPerUsd: Number(getSetting("krw_per_usd"))
  };
}

export function eventCostUsd(eventId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE event_id = ?").get(eventId) as { total: number };
  return row.total;
}

export function mapEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    organization: row.organization,
    topic: row.topic,
    glossary: row.glossary,
    consentConfirmed: row.consent_confirmed,
    status: row.status,
    finalNote: row.final_note,
    budgetUsd: Number(row.budget_usd),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapLecture(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    title: row.title,
    speaker: row.speaker,
    kind: row.kind,
    captureMode: row.capture_mode,
    noteStatus: row.note_status,
    noteError: row.note_error,
    topic: row.topic,
    status: row.status,
    recordedMs: row.recorded_ms,
    analyzedUntilMs: row.analyzed_until_ms,
    finalNote: row.final_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapSegment(row: Record<string, unknown>) {
  let providerMetadata: Record<string, unknown> | null = null;
  try { providerMetadata = row.provider_metadata ? JSON.parse(String(row.provider_metadata)) : null; } catch { providerMetadata = null; }
  return {
    id: row.id,
    lectureId: row.lecture_id,
    chunkId: row.chunk_id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    rawText: row.raw_text,
    overrideText: row.override_text,
    confidence: row.confidence,
    provider: row.provider,
    providerMetadata,
    createdAt: row.created_at
  };
}
