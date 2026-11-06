export type EventStatus = "active" | "archived";
export type LectureStatus = "draft" | "recording" | "paused" | "processing" | "complete";
export type ChunkStatus = "pending" | "processing" | "done" | "failed" | "budget_blocked";

export interface EventRecord {
  id: string;
  title: string;
  organization: string;
  topic: string;
  glossary: string;
  consentConfirmed: number;
  status: EventStatus;
  finalNote: string;
  budgetUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface LectureRecord {
  id: string;
  eventId: string;
  title: string;
  speaker: string;
  topic: string;
  status: LectureStatus;
  recordedMs: number;
  analyzedUntilMs: number;
  finalNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface AudioChunkRecord {
  id: string;
  lectureId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  wavPath: string;
  flacPath: string;
  status: ChunkStatus;
  attempts: number;
  nextAttemptAt: string;
  error: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptSegment {
  id: string;
  lectureId: string;
  chunkId: string;
  startMs: number;
  endMs: number;
  rawText: string;
  overrideText: string;
  confidence: number | null;
  provider: string;
  providerMetadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Bookmark {
  id: string;
  lectureId: string;
  atMs: number;
  note: string;
  createdAt: string;
}

export interface UsageLedger {
  id: string;
  eventId: string;
  lectureId: string;
  provider: "openai";
  model: string;
  kind: "transcription" | "live_note" | "final_note" | "event_note";
  inputUnits: number;
  outputUnits: number;
  costUsd: number;
  createdAt: string;
}

export interface LiveNoteItem {
  text: string;
  timestamps: string[];
}

export interface LiveNoteTableRow {
  cells: string[];
  timestamps: string[];
}

export interface LiveNoteTable {
  title: string;
  headers: string[];
  rows: LiveNoteTableRow[];
}

export interface LiveNoteSection {
  heading: string;
  summary: string;
  points: LiveNoteItem[];
  tables: LiveNoteTable[];
}

export interface LiveNoteState {
  title: string;
  summary: string;
  keyMessages: LiveNoteItem[];
  sections: LiveNoteSection[];
  uncertainties: LiveNoteItem[];
  updatedAt?: string;
}

export interface AppSettings {
  sttModel: "gpt-transcribe";
  realtimeSttEnabled: boolean;
  realtimeSttModel: "gpt-live-transcribe";
  liveModel: string;
  finalModel: string;
  budgetUsd: number;
  krwPerUsd: number;
  openAiKeyPresent: boolean;
  openAiKeyStatus: "missing" | "unchecked" | "valid" | "invalid";
  openAiKeySource: "env" | "file" | "missing";
}
