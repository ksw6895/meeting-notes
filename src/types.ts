export interface Lecture {
  id: string; eventId: string; title: string; speaker: string; topic: string;
  status: "draft" | "recording" | "paused" | "processing" | "complete";
  recordedMs: number; analyzedUntilMs: number; finalNote: string; createdAt: string; updatedAt: string;
  chunkCount?: number; doneChunks?: number; segmentCount?: number;
  storageBytes?: number;
}
export interface TranscriptSegment {
  id: string; lectureId: string; chunkId: string; startMs: number; endMs: number;
  rawText: string; overrideText: string; confidence: number | null; createdAt: string;
}
export interface Bookmark { id: string; lectureId: string; atMs: number; note: string; createdAt: string; sourceSegmentId?: string | null }
export interface NoteItem { text: string; timestamps: string[] }
export interface DynamicNoteTableRow { cells: string[]; timestamps: string[] }
export interface DynamicNoteTable { title: string; headers: string[]; rows: DynamicNoteTableRow[] }
export interface DynamicNoteSection { heading: string; summary: string; points: NoteItem[]; tables: DynamicNoteTable[] }
export interface LiveNote {
  title?: string; summary?: string; overview?: string; keyMessages?: NoteItem[];
  sections?: DynamicNoteSection[]; uncertainties?: NoteItem[]; updatedAt?: string;
  // Legacy fields remain readable while existing saved sessions migrate.
  topics?: NoteItem[]; keyPoints?: NoteItem[]; numbersAndDrugs?: NoteItem[];
  caveats?: NoteItem[]; questions?: NoteItem[];
}
export interface LectureDetail extends Lecture {
  segments: TranscriptSegment[]; bookmarks: Bookmark[]; liveNote: LiveNote | null;
  chunks: Array<{ id: string; sequence: number; startMs: number; endMs: number; status: string; error: string; flacPath: string }>;
  costUsd: number; originalAudioPresent?: boolean; originalBytes?: number; storageBytes?: number;
}
export interface Settings {
  sttModel: "gpt-transcribe";
  realtimeSttEnabled: boolean;
  realtimeSttModel: "gpt-live-transcribe";
  liveModel: string; finalModel: string; budgetUsd: number; krwPerUsd: number;
  openAiKeyPresent: boolean;
  openAiKeyStatus: "missing" | "unchecked" | "valid" | "invalid";
  openAiKeySource: "env" | "file" | "missing";
  noteModels: Array<{ id: string; label: string; inputUsd: number; outputUsd: number }>;
}
