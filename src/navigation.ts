export interface TimedSegment {
  id: string;
  startMs: number;
  endMs: number;
}

export interface SourceTarget {
  lectureId: string;
  segmentId: string;
}

export const sourceAnchorId = (lectureId: string, segmentId: string) => `source-${lectureId}-${segmentId}`;

export function parseSourceTarget(href: string): SourceTarget | null {
  let hash = href;
  let lectureFromQuery = "";
  try {
    const url = new URL(href, "http://localhost");
    hash = url.hash;
    lectureFromQuery = url.searchParams.get("lecture") || "";
  } catch {
    // A plain fragment is handled below.
  }
  const value = hash.replace(/^#/, "");
  const uuidPair = /^source-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value);
  if (uuidPair) return { lectureId: lectureFromQuery || uuidPair[1], segmentId: uuidPair[2] };
  if (lectureFromQuery && value.startsWith(`source-${lectureFromQuery}-`)) {
    return { lectureId: lectureFromQuery, segmentId: value.slice(`source-${lectureFromQuery}-`.length) };
  }
  return null;
}

export function timestampToMs(value: string): number | null {
  const clock = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/.exec(value);
  if (clock) return ((Number(clock[1] || 0) * 3600) + (Number(clock[2]) * 60) + Number(clock[3])) * 1000;
  const compact = /(?:^|#)t-(\d{4}|\d{6})(?:-|$)/.exec(value);
  if (!compact) return null;
  const digits = compact[1];
  const hours = digits.length === 6 ? Number(digits.slice(0, 2)) : 0;
  const minutes = Number(digits.slice(-4, -2));
  const seconds = Number(digits.slice(-2));
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

export function nearestSegmentId(segments: TimedSegment[], atMs: number): string | null {
  if (!segments.length) return null;
  const containing = segments.find((segment) => segment.startMs <= atMs && atMs <= segment.endMs);
  if (containing) return containing.id;
  return segments.reduce((best, segment) => {
    const bestDistance = Math.min(Math.abs(best.startMs - atMs), Math.abs(best.endMs - atMs));
    const distance = Math.min(Math.abs(segment.startMs - atMs), Math.abs(segment.endMs - atMs));
    return distance < bestDistance ? segment : best;
  }).id;
}
