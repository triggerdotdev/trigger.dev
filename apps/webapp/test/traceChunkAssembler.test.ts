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

describe("TraceChunkAssembler.tailBase", () => {
  it("returns the greatest merged write time", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([
      ev("r", "", 0, { insertedAt: "1000" }),
      ev("a", "r", 10, { insertedAt: "5000" }),
      ev("b", "r", 20, { insertedAt: "3000" }),
    ]);
    expect(a.tailBase()).toBe(5000);
  });

  it("tracks the max write time across merges (incl. tail-source reads)", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0, { insertedAt: "1000" })]);
    a.mergeChunk([ev("a", "r", 10, { insertedAt: "9000" })], { source: "tail" });
    a.mergeChunk([ev("b", "r", 20, { insertedAt: "4000" })], { source: "tail" });
    expect(a.tailBase()).toBe(9000);
  });

  it("uses the pinned floor until a tail from it completes", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0, { insertedAt: "9000" })]);
    a.pinTailFloor(4000);
    a.pinTailFloor(6000);
    expect(a.tailBase()).toBe(4000);
    a.completeTailRead(5000, 7000); // started past the floor, so it doesn't cover it
    expect(a.tailBase()).toBe(4000);
    a.completeTailRead(4000, 7000);
    expect(a.tailBase()).toBe(7000);
  });

  it("only lets completed tail reads advance the base", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0, { insertedAt: "1000" })]);
    a.pinTailFloor(1000);
    a.completeTailRead(1000, 1000);
    a.mergeChunk([ev("e", "r", 10, { insertedAt: "9000" })], { source: "errors" });
    a.mergeChunk([ev("d", "r", 20, { insertedAt: "9500" })], { source: "deeplink" });
    a.beginTailRead();
    a.mergeChunk([ev("t", "r", 30, { insertedAt: "3000" })], { source: "tail" });
    expect(a.tailBase()).toBe(1000);
    a.completeTailRead(1000, 2500);
    expect(a.tailBase()).toBe(2500);
  });

  it("keeps a held floor even after a completed tail", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0, { insertedAt: "9000" })]);
    a.pinTailFloor(4000);
    a.holdTailFloor(true);
    a.completeTailRead(4000, 8000);
    expect(a.tailBase()).toBe(4000);
    a.holdTailFloor(false);
    a.completeTailRead(4000, 8000);
    expect(a.tailBase()).toBe(8000);
  });

  it("returns null when no merged row carries a write time (v1/empty)", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0)]);
    a.pinTailFloor(1000);
    expect(a.tailBase()).toBeNull();
    expect(new TraceChunkAssembler().tailBase()).toBeNull();
  });
});

describe("TraceChunkAssembler tail source (partial-completion + event de-dup)", () => {
  const spanEvent = (spanId: string, offsetMs: number, message: string) =>
    ev(spanId, "r", offsetMs, { kind: "SPAN_EVENT", message, metadata: "{}" });

  it("flips a partial span to complete when the tail delivers the late completion row", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0, { status: "PARTIAL", duration: 0, insertedAt: "1000" })]);
    expect(a.spans.find((n) => n.id === "r")?.data.isPartial).toBe(true);
    // The completion row is written late but keeps the root's original start_time.
    a.mergeChunk([ev("r", "", 0, { status: "OK", duration: 900, insertedAt: "90000" })], {
      source: "tail",
    });
    expect(a.spans.find((n) => n.id === "r")?.data.isPartial).toBe(false);
  });

  it("does not re-push a span-event when the tail re-reads the overlap window", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0), ev("s", "r", 10)]);
    const exc = spanEvent("s", 12, "exception");
    // Same overlap window re-read on three consecutive ticks.
    for (let tick = 0; tick < 3; tick++) {
      a.beginTailRead();
      a.mergeChunk([exc], { source: "tail" });
    }
    expect(a.spans.find((n) => n.id === "s")?.data.events).toHaveLength(1);
  });

  it("still surfaces a genuinely new span-event on a later tail tick", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0), ev("s", "r", 10)]);
    a.beginTailRead();
    a.mergeChunk([spanEvent("s", 12, "first")], { source: "tail" });
    a.beginTailRead();
    a.mergeChunk([spanEvent("s", 12, "first")], { source: "tail" }); // re-read, no dup
    a.beginTailRead();
    a.mergeChunk([spanEvent("s", 12, "first"), spanEvent("s", 14, "second")], { source: "tail" });
    expect(a.spans.find((n) => n.id === "s")?.data.events).toHaveLength(2);
  });

  it("keeps two identical events split across pages of one tick", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0), ev("s", "r", 10)]);
    const twin = ev("s", "r", 12, { kind: "SPAN_EVENT", message: "retry", insertedAt: "5000" });
    a.beginTailRead();
    a.mergeChunk([twin], { source: "tail" });
    a.mergeChunk([twin], { source: "tail" });
    expect(a.spans.find((n) => n.id === "s")?.data.events).toHaveLength(2);
  });

  it("keeps an identical event written after its twin left the tail window", () => {
    const a = new TraceChunkAssembler();
    const event = (insertedAt: string) =>
      ev("s", "r", 12, { kind: "SPAN_EVENT", message: "retry", insertedAt });
    a.mergeChunk([ev("r", "", 0), ev("s", "r", 10), event("1000")]);
    a.beginTailRead();
    a.mergeChunk([event("60000")], { source: "tail" });
    expect(a.spans.find((n) => n.id === "s")?.data.events).toHaveLength(2);
  });

  it("does not duplicate deep-link events when the same payload is merged again", () => {
    const a = new TraceChunkAssembler();
    const deepLinked = [
      ev("r", "", 0),
      ev("r", "", 5, { kind: "SPAN_EVENT", message: "root event", insertedAt: "1000" }),
    ];
    a.mergeChunk(deepLinked, { source: "deeplink" });
    a.mergeChunk(deepLinked, { source: "deeplink" });
    a.mergeChunk(deepLinked, { source: "deeplink" });
    expect(a.spans.find((n) => n.id === "r")?.data.events).toHaveLength(1);
  });

  it("does not duplicate a row that the stream and the tail both read", () => {
    const a = new TraceChunkAssembler();
    const event = ev("s", "r", 12, { kind: "SPAN_EVENT", message: "once", insertedAt: "1000" });
    a.mergeChunk([ev("r", "", 0), ev("s", "r", 10), event]);
    a.beginTailRead();
    a.mergeChunk([event], { source: "tail" });
    expect(a.spans.find((n) => n.id === "s")?.data.events).toHaveLength(1);
  });
});

describe("TraceChunkAssembler.changedSinceRender", () => {
  // Merges `initial`, marks it rendered, then reports whether `next` changed anything.
  const changes = (initial: TraceChunkEvent[], next: TraceChunkEvent[]) => {
    const a = new TraceChunkAssembler();
    a.mergeChunk(initial);
    a.markRendered();
    a.beginTailRead();
    a.mergeChunk(next, { source: "tail" });
    return a.changedSinceRender;
  };

  it("starts changed so the first render happens", () => {
    expect(new TraceChunkAssembler().changedSinceRender).toBe(true);
  });

  it("stays unchanged when the tail re-reads rows it already has", () => {
    const rows = [
      ev("r", "", 0, { insertedAt: "1000" }),
      ev("a", "r", 10, { insertedAt: "1001" }),
      ev("a", "r", 12, { kind: "SPAN_EVENT", message: "fork", insertedAt: "1002" }),
      ev("a", "r", 13, {
        metadata: JSON.stringify({
          style: { icon: "task", accessory: { items: [{ text: "x" }] } },
        }),
        insertedAt: "1003",
      }),
    ];
    expect(
      changes(
        rows,
        rows.map((row) => ({ ...row }))
      )
    ).toBe(false);
  });

  it("stays unchanged when a deep-link payload is re-sent", () => {
    const a = new TraceChunkAssembler();
    const deepLinked = [ev("r", "", 0), ev("r", "", 5, { kind: "SPAN_EVENT", message: "e" })];
    a.mergeChunk(deepLinked, { source: "deeplink" });
    a.markRendered();
    a.mergeChunk(
      deepLinked.map((row) => ({ ...row })),
      { source: "deeplink" }
    );
    expect(a.changedSinceRender).toBe(false);
  });

  it("changes when a new span arrives", () => {
    expect(changes([ev("r", "", 0)], [ev("a", "r", 10)])).toBe(true);
  });

  it("changes when a partial span completes", () => {
    expect(
      changes([ev("a", "", 10, { status: "PARTIAL" })], [ev("a", "", 10, { duration: 5 })])
    ).toBe(true);
  });

  it("changes when a new span event arrives", () => {
    expect(
      changes([ev("a", "", 10)], [ev("a", "", 11, { kind: "SPAN_EVENT", message: "x" })])
    ).toBe(true);
  });

  it("changes when the middle of a message changes at equal length", () => {
    expect(
      changes(
        [ev("a", "", 10, { message: "item 1/10" })],
        [ev("a", "", 10, { message: "item 2/10" })]
      )
    ).toBe(true);
  });

  it("changes when only the style accessory changes", () => {
    const withAccessory = (text: string) =>
      ev("a", "", 10, {
        metadata: JSON.stringify({ style: { accessory: { items: [{ text }] } } }),
      });
    expect(changes([withAccessory("$0.01")], [withAccessory("$0.02")])).toBe(true);
  });

  it("changes when the style icon changes", () => {
    expect(
      changes(
        [ev("a", "", 10, { metadata: '{"style":{"icon":"play"}}' })],
        [ev("a", "", 10, { metadata: '{"style":{"icon":"stop"}}' })]
      )
    ).toBe(true);
  });

  it("changes when attemptNumber changes", () => {
    expect(
      changes(
        [ev("a", "", 10, { metadata: '{"attemptNumber":1}' })],
        [ev("a", "", 10, { metadata: '{"attemptNumber":2}' })]
      )
    ).toBe(true);
  });

  it("changes when a span's start moves earlier (sibling reordering)", () => {
    expect(changes([ev("a", "", 20)], [ev("a", "", 10)])).toBe(true);
  });

  it("changes when a span's own row replaces a placeholder made by its event", () => {
    expect(
      changes(
        [ev("a", "", 12, { kind: "SPAN_EVENT", message: "exception" })],
        [ev("a", "", 10, { message: "process", status: "PARTIAL" })]
      )
    ).toBe(true);
  });

  it("stays unchanged when the tail re-reads a span's older partial row with its final row", () => {
    const partial = ev("c", "", 0, {
      status: "PARTIAL",
      message: "cache",
      metadata: JSON.stringify({ style: { icon: "cache" } }),
    });
    const final = ev("c", "", 0, {
      message: "cache.hit",
      duration: 5,
      metadata: JSON.stringify({ style: { icon: "cache-hit" } }),
    });
    expect(changes([partial, final], [partial, final])).toBe(false);
    expect(changes([partial, final], [final, partial])).toBe(false);
  });

  it("changes when only the duration changes", () => {
    expect(changes([ev("a", "", 0, { duration: 1 })], [ev("a", "", 0, { duration: 2 })])).toBe(
      true
    );
  });

  it("changes when only the attempt number changes", () => {
    const attempt = (n: number) =>
      ev("a", "", 0, { metadata: JSON.stringify({ attemptNumber: n }) });
    expect(changes([attempt(1)], [attempt(2)])).toBe(true);
  });

  it("changes when only the style variant changes", () => {
    const variant = (v: string) =>
      ev("a", "", 0, { metadata: JSON.stringify({ style: { variant: v } }) });
    expect(changes([variant("primary")], [variant("danger")])).toBe(true);
  });

  it("changes when only the style accessory changes", () => {
    const accessory = (text: string) =>
      ev("a", "", 0, {
        metadata: JSON.stringify({ style: { accessory: { items: [{ text }] } } }),
      });
    expect(changes([accessory("$0.01")], [accessory("$0.02")])).toBe(true);
  });

  it("clears on markRendered", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([ev("r", "", 0)]);
    a.markRendered();
    expect(a.changedSinceRender).toBe(false);
  });
});

describe("TraceChunkAssembler #sortNano fallback", () => {
  it("orders a span with a malformed nanosecond by its own ms start, not a later event", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([
      ev("r", "", 0),
      ev("a", "r", 10, { startTimeNano: "not-a-number" }), // bad nano; ms start = 10
      ev("b", "r", 20), // valid; ms start = 20
      ev("a", "r", 30, { kind: "SPAN_EVENT", startTimeNano: nanoAt(30, 0) }), // later valid event for "a"
    ]);
    // "a" started at 10ms (before "b" at 20ms) and must sort first, even though its
    // only valid nanosecond came from a 30ms event row.
    expect(flatIds(a, "r")).toEqual(["r", "a", "b"]);
  });
});

describe("TraceChunkAssembler merge order", () => {
  const message = (a: TraceChunkAssembler) => a.spans.find((n) => n.id === "c")?.data.message;
  const partial = ev("c", "", 0, { status: "PARTIAL", message: "cache" });
  const final = ev("c", "", 0, { message: "cache.hit", duration: 5 });

  it("keeps the final row's message whichever row arrives last", () => {
    const finalFirst = new TraceChunkAssembler();
    finalFirst.mergeChunk([final, partial]);
    const partialFirst = new TraceChunkAssembler();
    partialFirst.mergeChunk([partial, final]);
    expect(message(finalFirst)).toBe("cache.hit");
    expect(message(partialFirst)).toBe("cache.hit");
  });

  it("still takes a style only the partial row carries", () => {
    const a = new TraceChunkAssembler();
    a.mergeChunk([
      final,
      ev("c", "", 0, {
        status: "PARTIAL",
        message: "cache",
        metadata: JSON.stringify({ style: { icon: "cache" } }),
      }),
    ]);
    expect(a.spans.find((n) => n.id === "c")?.data.style.icon).toBe("cache");
  });
});
