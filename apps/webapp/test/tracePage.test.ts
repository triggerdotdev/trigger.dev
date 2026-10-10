import { describe, expect, it } from "vitest";
import type { TraceChunkEvent } from "~/v3/eventRepository/eventRepository.types";
import { buildTracePage } from "~/v3/eventRepository/tracePage";

const BASE = new Date("2026-09-01T10:00:00.000Z");

function row(overrides: Partial<TraceChunkEvent> & { spanId: string }): TraceChunkEvent {
  const startTime = overrides.startTime ?? BASE;
  return {
    parentSpanId: "",
    runId: "run_1",
    startTime,
    startTimeNano: (BigInt(startTime.getTime()) * 1_000_000n).toString(),
    duration: 0,
    status: "OK",
    kind: "SPAN",
    message: overrides.spanId,
    metadata: "{}",
    ...overrides,
  };
}

describe("buildTracePage", () => {
  it("merges a span's rows into one item whatever their order", () => {
    const partial = row({ spanId: "a", status: "PARTIAL", message: "old name" });
    const final = row({ spanId: "a", status: "OK", message: "new name", duration: 5_000_000 });

    for (const rows of [
      [partial, final],
      [final, partial],
    ]) {
      const { spans } = buildTracePage(rows);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        id: "a",
        message: "new name",
        isPartial: false,
        duration: 5_000_000,
      });
    }
  });

  it("maps cancelled and errored spans", () => {
    const { spans } = buildTracePage([
      row({ spanId: "cancelled", status: "CANCELLED" }),
      row({ spanId: "errored", status: "ERROR" }),
      row({ spanId: "running", status: "PARTIAL" }),
    ]);
    const byId = Object.fromEntries(spans.map((span) => [span.id, span]));

    expect(byId.cancelled).toMatchObject({ isCancelled: true, isError: false, isPartial: false });
    expect(byId.errored).toMatchObject({ isError: true, isCancelled: false, isPartial: false });
    expect(byId.running).toMatchObject({ isPartial: true, isError: false, isCancelled: false });
  });

  it("keeps the attempt number from the span's metadata", () => {
    const { spans } = buildTracePage([
      row({ spanId: "attempt", metadata: JSON.stringify({ attemptNumber: 2 }) }),
    ]);
    expect(spans[0].attemptNumber).toBe(2);
  });

  it("doesn't turn annotation rows into spans", () => {
    const later = new Date(BASE.getTime() + 60_000);
    const { spans } = buildTracePage([
      row({ spanId: "b", kind: "SPAN_EVENT", message: "exception", startTime: later }),
      row({ spanId: "c", kind: "ANCESTOR_OVERRIDE", message: "attempt_failed", startTime: later }),
    ]);
    expect(spans).toEqual([]);
  });

  it("collects failed attempts with the run they apply to", () => {
    const { spans, attemptFailures } = buildTracePage([
      row({ spanId: "run-span", status: "PARTIAL" }),
      row({
        spanId: "run-span",
        kind: "ANCESTOR_OVERRIDE",
        message: "attempt_failed",
        startTime: new Date(BASE.getTime() + 1_000),
        metadata: JSON.stringify({ exception: {}, attemptNumber: 1, runId: "run_child" }),
      }),
      row({
        spanId: "run-span",
        kind: "ANCESTOR_OVERRIDE",
        message: "cancellation",
        metadata: JSON.stringify({ attemptNumber: 9, runId: "run_child" }),
      }),
    ]);

    expect(spans.map((span) => span.id)).toEqual(["run-span"]);
    expect(attemptFailures).toEqual([{ spanId: "run-span", attemptNumber: 1, runId: "run_child" }]);
  });

  it("ignores failed-attempt rows with unusable metadata", () => {
    const { attemptFailures } = buildTracePage([
      row({ spanId: "x", kind: "ANCESTOR_OVERRIDE", message: "attempt_failed", metadata: "nope" }),
      row({
        spanId: "y",
        kind: "ANCESTOR_OVERRIDE",
        message: "attempt_failed",
        metadata: JSON.stringify({ attemptNumber: "1", runId: "run_1" }),
      }),
    ]);
    expect(attemptFailures).toEqual([]);
  });
});
