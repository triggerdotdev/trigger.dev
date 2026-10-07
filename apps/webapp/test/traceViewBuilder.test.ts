import { describe, expect, it } from "vitest";
import type { TraceChunkEvent } from "~/v3/eventRepository/eventRepository.types";
import { TraceChunkAssembler } from "~/v3/eventRepository/traceChunkAssembler";
import { applyAncestorOverrides, buildTraceView } from "~/v3/eventRepository/traceViewBuilder";

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
    duration: 1_000_000,
    status: "OK",
    kind: "SPAN",
    message: spanId,
    metadata: "{}",
    ...overrides,
  };
}

const OPTS = {
  rootSpanId: "r",
  runFriendlyId: "run_r",
  isAgentRun: false,
  isAdmin: false,
};

function pipeline(events: TraceChunkEvent[]) {
  const assembler = new TraceChunkAssembler();
  assembler.mergeChunk(events);
  const { spans, overridesBySpanId } = applyAncestorOverrides(assembler.spans);
  return { view: buildTraceView(spans, OPTS), overridesBySpanId };
}

describe("buildTraceView", () => {
  it("flattens depth-first with root-relative offsets", () => {
    const events = [ev("r", "", 0), ev("a", "r", 100), ev("c", "a", 200), ev("b", "r", 300)];

    const { view } = pipeline(events);

    expect(view.events.map((e) => e.id)).toEqual(["r", "a", "c", "b"]);
    expect(view.events.map((e) => e.data.offset)).toEqual([
      0, 100_000_000, 200_000_000, 300_000_000,
    ]);
    expect(view.events[0].data.isRoot).toBe(true);
    expect(view.rootSpanStatus).toBe("completed");
    expect(view.missingAnchor).toBe(false);
  });

  it("reports rootSpanStatus executing while the root is partial", () => {
    const { view } = pipeline([ev("r", "", 0, { status: "PARTIAL" })]);
    expect(view.rootSpanStatus).toBe("executing");
    expect(view.events[0].data.duration).toBeNull();
  });

  it("reports missingAnchor when the anchor span hasn't loaded", () => {
    const { view } = pipeline([ev("child", "not-loaded", 100)]);
    expect(view.missingAnchor).toBe(true);
    expect(view.events).toEqual([]);
  });

  it("propagates a cancelled ancestor onto its partial TRACE descendant", () => {
    const events = [
      ev("r", "", 0),
      ev("a", "r", 100, { status: "CANCELLED", duration: 5_000_000 }),
      ev("b", "a", 200, { status: "PARTIAL", duration: 0 }),
    ];

    const { view, overridesBySpanId } = pipeline(events);
    const b = view.events.find((e) => e.id === "b");

    expect(b?.data.isCancelled).toBe(true);
    expect(b?.data.isPartial).toBe(false);
    expect(overridesBySpanId["b"]?.isCancelled).toBe(true);
  });
});
