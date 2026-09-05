import { describe, expect, it } from "vitest";
import {
  parseTranscriptSnapshot,
  type ChatSnapshotV1,
  type TranscriptSnapshotV2,
} from "../src/v3/sessionStreams/chatSnapshot.js";

const user = { id: "u-1", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] };
const assistant = {
  id: "a-1",
  role: "assistant" as const,
  parts: [{ type: "text" as const, text: "hello" }],
};

describe("parseTranscriptSnapshot", () => {
  it("returns a version 2 blob unchanged", () => {
    const blob: TranscriptSnapshotV2 = {
      version: 2,
      savedAt: 10,
      messages: [
        { id: "u-1", final: true, message: user },
        { id: "a-1", final: false, message: assistant },
      ],
      state: { summary: "s", through: "u-1" },
      lastOutEventId: "9",
      lastInEventId: "3",
    };

    expect(parseTranscriptSnapshot(blob)).toEqual(blob);
  });

  it("normalises a version 2 blob with no state to state: null", () => {
    const parsed = parseTranscriptSnapshot({
      version: 2,
      savedAt: 10,
      messages: [],
      state: undefined,
    });

    expect(parsed?.state).toBeNull();
  });

  it("upgrades a version 1 blob: every message final, state null, cursors kept", () => {
    const blob: ChatSnapshotV1 = {
      version: 1,
      savedAt: 10,
      messages: [user, assistant],
      lastOutEventId: "9",
      lastInEventId: "3",
    };

    expect(parseTranscriptSnapshot(blob)).toEqual({
      version: 2,
      savedAt: 10,
      messages: [
        { id: "u-1", final: true, message: user },
        { id: "a-1", final: true, message: assistant },
      ],
      state: null,
      lastOutEventId: "9",
      lastInEventId: "3",
    });
  });

  it("drops version 1 messages that have no string id", () => {
    const parsed = parseTranscriptSnapshot({
      version: 1,
      savedAt: 10,
      messages: [{ role: "user", parts: [] }, { id: 7, role: "user", parts: [] }, assistant, null],
    });

    expect(parsed?.messages.map((m) => m.id)).toEqual(["a-1"]);
  });

  it("returns undefined for unknown versions and non-snapshot bodies", () => {
    expect(parseTranscriptSnapshot({ version: 3, savedAt: 1, messages: [] })).toBeUndefined();
    expect(
      parseTranscriptSnapshot({ version: 2, savedAt: 1, messages: [{ id: "x" }] })
    ).toBeUndefined();
    expect(parseTranscriptSnapshot({ version: 1, savedAt: "1", messages: [] })).toBeUndefined();
    expect(parseTranscriptSnapshot({ message: "Not Found" })).toBeUndefined();
    expect(parseTranscriptSnapshot(undefined)).toBeUndefined();
    expect(parseTranscriptSnapshot([])).toBeUndefined();
  });
});
