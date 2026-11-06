import { describe, expect, it } from "vitest";
import { nearestSegmentId, parseSourceTarget, sourceAnchorId, timestampToMs } from "../src/navigation.ts";

describe("source navigation", () => {
  const lectureId = "11111111-1111-4111-8111-111111111111";
  const segmentId = "22222222-2222-4222-8222-222222222222";

  it("parses lecture and event source links", () => {
    expect(parseSourceTarget(`#${sourceAnchorId(lectureId, segmentId)}`)).toEqual({ lectureId, segmentId });
    expect(parseSourceTarget(`?lecture=${lectureId}#${sourceAnchorId(lectureId, segmentId)}`)).toEqual({ lectureId, segmentId });
  });

  it("parses range and legacy compact timestamps", () => {
    expect(timestampToMs("00:28–01:00")).toBe(28_000);
    expect(timestampToMs("#t-0128-0200")).toBe(88_000);
    expect(timestampToMs("1:02:03")).toBe(3_723_000);
  });

  it("finds a containing segment or the closest segment", () => {
    const segments = [
      { id: "a", startMs: 0, endMs: 30_000 },
      { id: "b", startMs: 58_000, endMs: 90_000 }
    ];
    expect(nearestSegmentId(segments, 15_000)).toBe("a");
    expect(nearestSegmentId(segments, 55_000)).toBe("b");
  });
});
