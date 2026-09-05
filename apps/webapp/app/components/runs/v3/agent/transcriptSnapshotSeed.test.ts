import { describe, expect, it } from "vitest";
import { seedFromTranscriptSnapshot } from "./transcriptSnapshotSeed";

const user = { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] };
const assistant = { id: "a-1", role: "assistant", parts: [{ type: "text", text: "world" }] };

describe("seedFromTranscriptSnapshot", () => {
  it("seeds from a version 1 snapshot in array order", () => {
    const seed = seedFromTranscriptSnapshot({
      version: 1,
      savedAt: 1_000,
      messages: [user, assistant],
      lastOutEventId: "42",
      lastInEventId: "7",
    });

    expect(seed).toBeDefined();
    expect(seed!.lastOutEventId).toBe("42");
    expect(seed!.messages.map((m) => m.id)).toEqual(["u-1", "a-1"]);
    expect(seed!.messages.map((m) => m.timestamp)).toEqual([998, 999]);
    expect(seed!.messages[1]!.message).toEqual(assistant);
  });

  it("seeds from a version 2 snapshot, unwrapping the message envelope", () => {
    const seed = seedFromTranscriptSnapshot({
      version: 2,
      savedAt: 1_000,
      messages: [
        { id: "u-1", final: true, message: user },
        { id: "a-1", final: false, message: assistant },
      ],
      state: { summary: "irrelevant to rendering" },
      lastOutEventId: "42",
      lastInEventId: "7",
    });

    expect(seed).toBeDefined();
    expect(seed!.lastOutEventId).toBe("42");
    expect(seed!.messages.map((m) => m.id)).toEqual(["u-1", "a-1"]);
    expect(seed!.messages.map((m) => m.timestamp)).toEqual([998, 999]);
    expect(seed!.messages[1]!.message).toEqual(assistant);
  });

  it("skips version 1 entries without an id but keeps the others' positions", () => {
    const seed = seedFromTranscriptSnapshot({
      version: 1,
      savedAt: 1_000,
      messages: [{ role: "user", parts: [] }, assistant],
    });

    expect(seed!.messages.map((m) => m.id)).toEqual(["a-1"]);
    expect(seed!.messages[0]!.timestamp).toBe(999);
    expect(seed!.lastOutEventId).toBeUndefined();
  });

  it("returns undefined for an unknown version or a non-snapshot body", () => {
    expect(seedFromTranscriptSnapshot({ version: 3, savedAt: 1, messages: [] })).toBeUndefined();
    expect(seedFromTranscriptSnapshot({ error: "not found" })).toBeUndefined();
    expect(seedFromTranscriptSnapshot(null)).toBeUndefined();
    expect(seedFromTranscriptSnapshot("[]")).toBeUndefined();
  });
});
