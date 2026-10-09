import { describe, expect, it } from "vitest";
import {
  buildTraceChunkCursorPredicate,
  sliceTraceChunk,
  TRACE_CHUNK_ORDER_BY,
  type TraceChunkCursor,
} from "./taskEvents.js";

describe("buildTraceChunkCursorPredicate", () => {
  it("produces the (start_time, span_id) boundary predicate", () => {
    const cursor: TraceChunkCursor = { startTime: "1758629566130262875", spanId: "span_b" };
    const { clause, params } = buildTraceChunkCursorPredicate(cursor);

    expect(clause).toBe(
      "toUnixTimestamp(start_time) >= intDiv({cursorStartTime: Int64}, 1000000000) AND (toUnixTimestamp64Nano(start_time) > {cursorStartTime: Int64} OR (toUnixTimestamp64Nano(start_time) = {cursorStartTime: Int64} AND span_id > {cursorSpanId: String}))"
    );
    expect(params).toEqual({
      cursorStartTime: "1758629566130262875",
      cursorSpanId: "span_b",
    });
  });

  it("orders by (start_time, span_id) so the cursor tuple is total", () => {
    expect(TRACE_CHUNK_ORDER_BY).toBe("start_time ASC, span_id ASC");
  });
});

describe("sliceTraceChunk", () => {
  const row = (cursor_start_time: string, span_id: string) => ({ cursor_start_time, span_id });

  it("returns everything with no next cursor when the trace fits in one chunk", () => {
    const rows = [row("100", "a"), row("200", "b")];
    const result = sliceTraceChunk(rows, 5);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.events).toEqual(rows);
  });

  it("returns a full chunk and a resume cursor when exactly `limit` rows remain after it", () => {
    const rows = [row("100", "a"), row("200", "b"), row("300", "c")];
    const result = sliceTraceChunk(rows, 2);

    expect(result.hasMore).toBe(true);
    expect(result.events).toEqual([row("100", "a"), row("200", "b")]);
    expect(result.nextCursor).toEqual({ startTime: "200", spanId: "b" });
  });

  it("never splits a (start_time, span_id) group across a chunk boundary", () => {
    const rows = [row("100", "a"), row("200", "b"), row("200", "b"), row("300", "c")];
    const result = sliceTraceChunk(rows, 2);

    expect(result.hasMore).toBe(true);
    expect(result.events).toEqual([row("100", "a")]);
    expect(result.nextCursor).toEqual({ startTime: "100", spanId: "a" });
  });

  it("keeps equal-timestamp rows for distinct spans (they are distinct keys)", () => {
    const rows = [row("200", "a"), row("200", "b"), row("200", "c")];
    const result = sliceTraceChunk(rows, 2);

    expect(result.hasMore).toBe(true);
    expect(result.events).toEqual([row("200", "a"), row("200", "b")]);
    expect(result.nextCursor).toEqual({ startTime: "200", spanId: "b" });
  });

  it("signals incompleteKey when a single key exceeds the whole chunk (degenerate)", () => {
    const rows = [row("200", "a"), row("200", "a"), row("200", "a")];
    const result = sliceTraceChunk(rows, 2);

    expect(result.hasMore).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.incompleteKey).toEqual({ startTime: "200", spanId: "a" });
    expect(result.nextCursor).toEqual({ startTime: "200", spanId: "a" });
  });
});
