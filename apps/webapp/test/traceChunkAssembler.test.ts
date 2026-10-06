import { describe, expect, it } from "vitest";
import type { TraceChunkEvent } from "~/v3/eventRepository/eventRepository.types";
import { TraceChunkAssembler } from "~/v3/eventRepository/traceChunkAssembler";

const BASE = new Date("2026-09-01T10:00:00.000Z");

function ev(
  spanId: string,
  parentSpanId: string,
  offsetMs: number,
  overrides: Partial<TraceChunkEvent> = {}
): TraceChunkEvent {
  return {
    spanId,
    parentSpanId,
    runId: `run_${spanId}`,
    startTime: new Date(BASE.getTime() + offsetMs),
    startTimeNano: String((BigInt(BASE.getTime()) + BigInt(offsetMs)) * 1_000_000n),
    duration: 0,
    status: "OK",
    kind: "SPAN",
    message: spanId,
    metadata: "{}",
    ...overrides,
  };
}

function nanoAt(offsetMs: number, extraNs: number): string {
  return String((BigInt(BASE.getTime()) + BigInt(offsetMs)) * 1_000_000n + BigInt(extraNs));
}

function assembleInChunks(events: TraceChunkEvent[], chunkSize: number): TraceChunkAssembler {
  const assembler = new TraceChunkAssembler();
  for (let i = 0; i < events.length; i += chunkSize) {
    assembler.mergeChunk(events.slice(i, i + chunkSize));
  }
  return assembler;
}

function flatIds(assembler: TraceChunkAssembler, root: string): string[] {
  return assembler.flatten(root).map((n) => n.id);
}

describe("TraceChunkAssembler", () => {
  const events: TraceChunkEvent[] = [
    ev("r", "", 0),
    ev("a", "r", 10, { status: "PARTIAL", duration: 0 }),
    ev("b", "r", 10),
    ev("a", "r", 10, { status: "OK", duration: 500 }),
    ev("c", "a", 20),
    ev("log1", "a", 25, { kind: "LOG_INFO", message: "hello" }),
  ];

  it("assembles the same tree regardless of chunk boundaries (matches a single-request load)", () => {
    const single = assembleInChunks(events, events.length);
    const expected = flatIds(single, "r");

    expect(expected).toEqual(["r", "a", "c", "log1", "b"]);

    for (const chunkSize of [1, 2, 3]) {
      const paged = assembleInChunks(events, chunkSize);
      expect(flatIds(paged, "r")).toEqual(expected);
      expect(paged.flatten("r")).toEqual(single.flatten("r"));
    }
  });

  it("merges a span's partial and complete rows across chunks", () => {
    const paged = assembleInChunks(events, 1);
    const a = paged.spans.find((s) => s.id === "a");

    expect(a).toBeDefined();
    expect(a?.data.isPartial).toBe(false);
    expect(a?.data.duration).toBe(500);
  });

  it("buffers an exact-timestamp orphan and attaches it when its parent arrives", () => {
    const orphanEvents: TraceChunkEvent[] = [ev("r", "", 0), ev("c", "p", 10), ev("p", "r", 10)];

    const assembler = new TraceChunkAssembler();

    assembler.mergeChunk([orphanEvents[0]]);
    expect(flatIds(assembler, "r")).toEqual(["r"]);

    assembler.mergeChunk([orphanEvents[1]]);
    expect(assembler.hasSpan("c")).toBe(true);
    expect(flatIds(assembler, "r")).toEqual(["r"]);

    assembler.mergeChunk([orphanEvents[2]]);
    expect(flatIds(assembler, "r")).toEqual(["r", "p", "c"]);

    const single = assembleInChunks(orphanEvents, orphanEvents.length);
    expect(assembler.flatten("r")).toEqual(single.flatten("r"));
  });

  it("orders siblings chronologically even when a supplementary fetch inserts a later span early", () => {
    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("r", "", 0), ev("A", "r", 10), ev("B", "r", 20)]);
    assembler.mergeChunk([ev("Z", "r", 50)], { source: "deeplink" });
    assembler.mergeChunk([ev("C", "r", 30), ev("D", "r", 40)]);
    assembler.mergeChunk([ev("Z", "r", 50)]);

    expect(flatIds(assembler, "r")).toEqual(["r", "A", "B", "C", "D", "Z"]);
  });

  it("orders sub-millisecond siblings by nanosecond start, not span id", () => {
    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([
      ev("r", "", 0),
      ev("z", "r", 10, { startTimeNano: nanoAt(10, 100_000) }),
      ev("a", "r", 10, { startTimeNano: nanoAt(10, 900_000) }),
    ]);

    expect(flatIds(assembler, "r")).toEqual(["r", "z", "a"]);
  });

  it("recovers span ordering from a later valid nanosecond after a malformed one", () => {
    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([
      ev("r", "", 0),
      ev("early", "r", 5),
      ev("late", "r", 10, { status: "PARTIAL", startTimeNano: "bad" }),
      ev("late", "r", 10, { status: "OK" }),
    ]);

    expect(flatIds(assembler, "r")).toEqual(["r", "early", "late"]);
  });

  it("returns an empty flatten until the root span has loaded", () => {
    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("child", "missing-root", 10)]);
    expect(assembler.flatten("missing-root")).toEqual([]);
  });

  it("does not duplicate a span-event row that a supplementary fetch also delivers", () => {
    const spanEvent = ev("a", "r", 15, {
      kind: "SPAN_EVENT",
      message: "exception",
      metadata: JSON.stringify({ exception: { message: "boom" } }),
    });

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("r", "", 0), ev("a", "r", 10)]);
    assembler.mergeChunk([spanEvent], { source: "errors" });
    assembler.mergeChunk([spanEvent]);

    const a = assembler.spans.find((s) => s.id === "a");
    expect(a?.data.events).toHaveLength(1);
    expect(a?.data.events[0]?.name).toBe("exception");
  });

  it("reconciles regardless of whether the stream or supplementary row arrives first", () => {
    const spanEvent = ev("a", "r", 15, { kind: "SPAN_EVENT", message: "exception" });

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("r", "", 0), ev("a", "r", 10)]);
    assembler.mergeChunk([spanEvent]);
    assembler.mergeChunk([spanEvent], { source: "errors" });

    const a = assembler.spans.find((s) => s.id === "a");
    expect(a?.data.events).toHaveLength(1);
  });

  it("does not double-count a row delivered by both supplementary sources (deep-link + errors)", () => {
    const spanEvent = ev("a", "r", 15, { kind: "SPAN_EVENT", message: "exception" });

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("r", "", 0), ev("a", "r", 10)]);
    assembler.mergeChunk([spanEvent], { source: "deeplink" });
    assembler.mergeChunk([spanEvent], { source: "errors" });
    assembler.mergeChunk([spanEvent]);

    const a = assembler.spans.find((s) => s.id === "a");
    expect(a?.data.events).toHaveLength(1);
  });

  it("keeps distinct span-events that differ only in metadata", () => {
    const first = ev("a", "r", 15, {
      kind: "SPAN_EVENT",
      message: "log",
      metadata: JSON.stringify({ n: 1 }),
    });
    const second = ev("a", "r", 15, {
      kind: "SPAN_EVENT",
      message: "log",
      metadata: JSON.stringify({ n: 2 }),
    });

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("r", "", 0), ev("a", "r", 10), first, second]);

    const a = assembler.spans.find((s) => s.id === "a");
    expect(a?.data.events).toHaveLength(2);
  });

  it("preserves two distinct events with identical content in the same millisecond", () => {
    const retry = () =>
      ev("a", "r", 15, {
        kind: "SPAN_EVENT",
        message: "retry",
        metadata: JSON.stringify({ attempt: 1 }),
      });

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("r", "", 0), ev("a", "r", 10), retry(), retry()]);

    const a = assembler.spans.find((s) => s.id === "a");
    expect(a?.data.events).toHaveLength(2);
  });

  it("does not inflate multiplicity when a supplementary fetch also carries both copies", () => {
    const retry = () =>
      ev("a", "r", 15, {
        kind: "SPAN_EVENT",
        message: "retry",
        metadata: JSON.stringify({ attempt: 1 }),
      });

    const assembler = new TraceChunkAssembler();
    assembler.mergeChunk([ev("r", "", 0), ev("a", "r", 10)]);
    assembler.mergeChunk([retry(), retry()], { source: "errors" });
    assembler.mergeChunk([retry(), retry()]);

    const a = assembler.spans.find((s) => s.id === "a");
    expect(a?.data.events).toHaveLength(2);
  });
});
