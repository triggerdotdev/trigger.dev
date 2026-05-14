// Import the test entry point first so the resource catalog is installed.
import "../src/v3/test/index.js";

import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager } from "@trigger.dev/core/v3";
import { __replaySessionOutTailProductionPathForTests as replaySessionOutTail } from "../src/v3/ai.js";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build the canonical chunk sequence the AI SDK emits for a single text
 * turn from message `id`. Includes a trailing `finish` so the segment is
 * marked closed (i.e. NOT subject to `cleanupAbortedParts`).
 */
function textTurn(id: string, text: string, role: "assistant" = "assistant"): UIMessageChunk[] {
  return [
    { type: "start", messageId: id, messageMetadata: { role } } as UIMessageChunk,
    { type: "text-start", id: `${id}.t1` } as UIMessageChunk,
    { type: "text-delta", id: `${id}.t1`, delta: text } as UIMessageChunk,
    { type: "text-end", id: `${id}.t1` } as UIMessageChunk,
    { type: "finish" } as UIMessageChunk,
  ];
}

/**
 * Same as `textTurn` but omits the trailing `finish` chunk — simulates a
 * crashed turn whose stream ended mid-message. The runtime's reducer
 * should run `cleanupAbortedParts` on the resulting trailing message.
 */
function partialTurn(id: string, text: string): UIMessageChunk[] {
  return [
    { type: "start", messageId: id, messageMetadata: { role: "assistant" } } as UIMessageChunk,
    { type: "text-start", id: `${id}.t1` } as UIMessageChunk,
    { type: "text-delta", id: `${id}.t1`, delta: text } as UIMessageChunk,
    // No text-end, no finish.
  ];
}

/**
 * Stub `apiClientManager.clientOrThrow().readSessionStreamRecords` so the
 * helper sees a `{ records: StreamRecord[] }` response. Each StreamRecord
 * is `{ data: string, id, seqNum }` — `data` is the JSON-encoded chunk
 * body the runtime then `JSON.parse`s.
 *
 * Pass either a `UIMessageChunk` (will be JSON.stringify'd) or a raw
 * string (used as `data` directly — for tests that need pre-stringified
 * or deliberately-malformed bodies).
 *
 * Captures the `afterEventId` argument for resume-from-cursor assertions.
 */
function stubReadRecordsWithChunks(chunks: unknown[]) {
  const records = chunks.map((chunk, i) => ({
    data: typeof chunk === "string" ? chunk : JSON.stringify(chunk),
    id: `evt-${i + 1}`,
    seqNum: i + 1,
  }));
  const readRecordsSpy = vi.fn(
    async (_id: string, _io: "in" | "out", _options?: { afterEventId?: string }) => ({
      records,
    })
  );
  vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
    readSessionStreamRecords: readRecordsSpy,
  } as never);
  return readRecordsSpy;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("replaySessionOutTail", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    warnSpy.mockRestore();
  });

  it("returns [] for an empty session.out stream", async () => {
    stubReadRecordsWithChunks([]);
    const result = await replaySessionOutTail("empty-session");
    expect(result).toEqual([]);
  });

  it("reduces a single text turn into one assistant UIMessage", async () => {
    stubReadRecordsWithChunks(textTurn("a-1", "hello world"));
    const result = await replaySessionOutTail("text-session");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "a-1", role: "assistant" });
    const text = (result[0]!.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("hello world");
  });

  it("reduces multiple sequential turns into multiple UIMessages", async () => {
    stubReadRecordsWithChunks([
      ...textTurn("a-1", "first"),
      ...textTurn("a-2", "second"),
      ...textTurn("a-3", "third"),
    ]);

    const result = await replaySessionOutTail("multi-session");
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(["a-1", "a-2", "a-3"]);
  });

  it("filters out `trigger:*` control chunks (turn-complete, etc.)", async () => {
    stubReadRecordsWithChunks([
      ...textTurn("a-1", "hello"),
      { type: "trigger:turn-complete", lastEventId: "evt-1", lastEventTimestamp: 1 },
      { type: "trigger:upgrade-required" },
      ...textTurn("a-2", "second"),
    ]);

    const result = await replaySessionOutTail("control-session");
    // Two assistant messages reduced — the trigger:* records are dropped
    // before reaching the reducer.
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(["a-1", "a-2"]);
  });

  it("never emits user-role messages (session.out is assistant-only)", async () => {
    // session.out conceptually only carries assistant chunks (the user's
    // messages live on session.in). Even if a user-role start somehow
    // landed there, the reducer wouldn't surface a user message via this
    // helper's contract.
    stubReadRecordsWithChunks(textTurn("a-1", "ok"));
    const result = await replaySessionOutTail("assistant-only");
    expect(result.every((m) => m.role !== "user")).toBe(true);
  });

  it("passes `lastEventId` through as `afterEventId` to readSessionStreamRecords", async () => {
    // The replay helper accepts `lastEventId` from the caller (matching
    // the snapshot's persisted cursor name) and forwards it as
    // `afterEventId` on the records endpoint — that's the field name on
    // the new non-SSE route.
    const readRecordsSpy = stubReadRecordsWithChunks(textTurn("a-1", "ok"));
    await replaySessionOutTail("resume-session", { lastEventId: "evt-99" });

    expect(readRecordsSpy).toHaveBeenCalledWith(
      "resume-session",
      "out",
      expect.objectContaining({ afterEventId: "evt-99" })
    );
  });

  it("uses the non-SSE records endpoint (drain-and-close, no long-poll)", async () => {
    // Replay no longer subscribes to the SSE stream — that imposed a ~1s
    // long-poll tax on every fresh chat boot. The new path hits
    // `readSessionStreamRecords` (one synchronous GET that returns
    // whatever's already in the stream) and returns immediately when
    // empty. Lock the call site down so a regression to SSE shows up
    // here.
    const readRecordsSpy = stubReadRecordsWithChunks([]);
    const result = await replaySessionOutTail("drain-session");

    expect(readRecordsSpy).toHaveBeenCalledWith("drain-session", "out", expect.any(Object));
    expect(result).toEqual([]);
  });

  it("strips orphaned in-flight tool parts from a partial trailing assistant", async () => {
    // The runtime applies `cleanupAbortedParts` only on the trailing
    // segment when its closure flag is `false` (no `finish` chunk
    // received). The cleanup removes tool parts that never reached a
    // terminal state — `input-streaming`, `output-pending`, etc. —
    // because those represent partial in-flight work that won't resolve.
    //
    // Text parts with already-streamed content are preserved (the user
    // already saw them), so we test the tool-part path specifically.
    stubReadRecordsWithChunks([
      ...textTurn("a-1", "previous-turn-finished"),
      // Trailing turn: starts a tool call but never resolves it.
      { type: "start", messageId: "a-2", messageMetadata: { role: "assistant" } } as UIMessageChunk,
      { type: "tool-input-start", toolCallId: "tc-cut", toolName: "search" } as UIMessageChunk,
      { type: "tool-input-delta", toolCallId: "tc-cut", inputTextDelta: '{"q":"x"}' } as UIMessageChunk,
      // No tool-input-end, no tool-call, no finish → orphaned.
    ]);

    const result = await replaySessionOutTail("partial-tool-session");
    // The closed turn survives.
    expect(result.find((m) => m.id === "a-1")).toBeTruthy();
    // Trailing message either gets dropped (cleanup empties it) or its
    // orphaned tool part is stripped to a terminal state. Either way,
    // no `tc-cut` part should be left in `input-streaming` state — that
    // would represent a tool the next turn would re-process.
    const trailing = result.find((m) => m.id === "a-2");
    if (trailing) {
      const orphanedToolPart = (trailing.parts as Array<{ type: string; toolCallId?: string; state?: string }>).find(
        (p) => p.toolCallId === "tc-cut" && p.state === "input-streaming"
      );
      expect(orphanedToolPart).toBeUndefined();
    }
  });

  it("drops a trailing message whose only parts are stripped by cleanup", async () => {
    // Trailing turn whose ONLY content is an orphaned tool — after
    // cleanup the message has no parts left, so the helper drops it
    // entirely (it never reached the next turn's accumulator).
    stubReadRecordsWithChunks([
      ...textTurn("a-1", "complete"),
      { type: "start", messageId: "a-orphan", messageMetadata: { role: "assistant" } } as UIMessageChunk,
      { type: "tool-input-start", toolCallId: "tc-orph", toolName: "search" } as UIMessageChunk,
      // No tool-input-end, no tool-call, no finish.
    ]);

    const result = await replaySessionOutTail("dropped-trailing");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a-1");
  });

  it("preserves a complete trailing assistant (cleanup is a no-op)", async () => {
    // Trailing turn that DID end with `finish` is closed — cleanupAbortedParts
    // doesn't fire. Use this to lock down that closed segments survive
    // unchanged.
    stubReadRecordsWithChunks(textTurn("a-1", "fully-finished"));
    const result = await replaySessionOutTail("closed-session");
    expect(result).toHaveLength(1);
    const text = (result[0]!.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("fully-finished");
  });

  it("JSON-decodes each record.data (every record arrives pre-serialized)", async () => {
    // The records endpoint hands each chunk back as a JSON string in
    // `record.data` — the agent JSON.parses it client-side so the
    // server's hot path doesn't pay the parse cost. Verify a normal
    // turn round-trips through JSON encode→decode.
    const stringChunks = textTurn("a-1", "from-string").map((c) => JSON.stringify(c));
    stubReadRecordsWithChunks(stringChunks);

    const result = await replaySessionOutTail("string-chunks");
    expect(result).toHaveLength(1);
    const text = (result[0]!.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("from-string");
  });

  it("skips records whose data is unparseable JSON", async () => {
    // The replay helper wraps the per-record JSON.parse in try/catch so
    // a single malformed record can't sink the rest of the replay. The
    // server should never serve a malformed `data`, but the defensive
    // catch lets a poisoned record skip cleanly.
    stubReadRecordsWithChunks([
      "not-json-{[",
      ...textTurn("a-1", "survived"),
    ]);

    const result = await replaySessionOutTail("garbage-session");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a-1");
  });

  it("skips records whose decoded data is not an object", async () => {
    // After JSON.parse, the helper requires `chunk` to be a non-null
    // object with a string `type` field. Records that decode to
    // primitives (number, string, etc.) are dropped silently.
    stubReadRecordsWithChunks([
      JSON.stringify(42),
      JSON.stringify(null),
      JSON.stringify("just-a-string"),
      ...textTurn("a-1", "survived"),
    ]);

    const result = await replaySessionOutTail("primitive-data-session");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a-1");
  });

  it("ignores chunks missing a `type` field", async () => {
    stubReadRecordsWithChunks([
      { foo: "bar" },
      { type: 42 },
      ...textTurn("a-1", "valid"),
    ]);

    const result = await replaySessionOutTail("typeless-session");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a-1");
  });

  it("recovers from a malformed segment by skipping it (logs a warn)", async () => {
    // The reducer for one segment throws (e.g. invalid chunk sequence).
    // The helper logs the warning and proceeds with the next segment —
    // a single corrupt segment shouldn't sink the entire replay.
    stubReadRecordsWithChunks([
      // Malformed: text-end with no preceding text-start.
      { type: "start", messageId: "bad-1", messageMetadata: { role: "assistant" } } as UIMessageChunk,
      { type: "text-end", id: "no-such-text" } as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
      ...textTurn("a-1", "after-bad"),
    ]);

    const result = await replaySessionOutTail("recovery-session");
    // The valid turn after the malformed one must still surface.
    expect(result.find((m) => m.id === "a-1")).toBeTruthy();
  });
});
