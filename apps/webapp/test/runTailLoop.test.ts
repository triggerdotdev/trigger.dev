import { describe, expect, it } from "vitest";
import { runTailLoop, type TailPageFetcher } from "~/hooks/useProgressiveTrace";
import type { TraceChunkCursor, TraceChunkEvent } from "~/v3/eventRepository/eventRepository.types";
import { TraceChunkAssembler } from "~/v3/eventRepository/traceChunkAssembler";

const BASE = new Date("2026-09-01T10:00:00.000Z").getTime();
const OVERLAP_MS = 30_000;

// Seed a write time for the tail to anchor on, as the initial load would.
function seed(assembler: TraceChunkAssembler, spanId: string, insertedAtMs: number, status = "OK") {
  const ev: TraceChunkEvent = {
    spanId,
    parentSpanId: "",
    runId: "r",
    startTime: new Date(BASE),
    startTimeNano: String(BigInt(BASE) * 1_000_000n),
    insertedAt: String(insertedAtMs),
    duration: 0,
    status,
    kind: "SPAN",
    message: spanId,
    metadata: "{}",
  };
  assembler.mergeChunk([ev]);
}

// A wire chunk row as the resource route serializes it (startTime as an ISO string).
function wireEv(
  spanId: string,
  parentSpanId: string,
  insertedAtMs: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    spanId,
    parentSpanId,
    runId: "r",
    startTime: new Date(BASE).toISOString(),
    startTimeNano: String(BigInt(BASE) * 1_000_000n),
    insertedAt: String(insertedAtMs),
    duration: 0,
    status: "OK",
    kind: "SPAN",
    message: spanId,
    metadata: "{}",
    ...overrides,
  };
}

const page = (
  events: unknown[],
  nextCursor: TraceChunkCursor | null,
  hasMore: boolean,
  readAt?: number
) => ({ events, nextCursor, hasMore, readAt });

type TailPage = Awaited<ReturnType<TailPageFetcher>>;

// Returns the canned pages in order (null once they run out) and records each request.
function recorder(pages: unknown[]) {
  const queue = [...pages] as TailPage[];
  const calls: Parameters<TailPageFetcher>[0][] = [];
  const fetchPage: TailPageFetcher = async (params) => {
    calls.push(params);
    return queue.shift() ?? null;
  };
  return { fetchPage, calls };
}

describe("runTailLoop", () => {
  it("does not fetch when nothing is loaded yet (no write time to anchor on)", async () => {
    const assembler = new TraceChunkAssembler();
    const { fetchPage, calls } = recorder([]);
    const result = await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ merged: false, truncated: false, finished: true });
  });

  it("pages through the window and merges each page under the tail source", async () => {
    const assembler = new TraceChunkAssembler();
    seed(assembler, "root", 100_000); // max write time 100_000 => since = 70_000
    const cursor2: TraceChunkCursor = { startTime: "n", spanId: "a" };
    const { fetchPage, calls } = recorder([
      page([wireEv("a", "root", 100_500)], cursor2, true),
      page([wireEv("b", "root", 100_600)], null, false),
    ]);

    const result = await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(result).toEqual({ merged: true, truncated: false, finished: true });
    expect(calls).toHaveLength(2);
    // Both pages fetched within the same write-time window; first has no cursor.
    expect(calls[0]).toMatchObject({
      cursor: undefined,
      insertedAtSince: 100_000 - OVERLAP_MS,
    });
    expect(calls[1]).toMatchObject({
      cursor: cursor2,
      insertedAtSince: 100_000 - OVERLAP_MS,
    });
    expect(assembler.spans.map((s) => s.id).sort()).toEqual(["a", "b", "root"]);
  });

  it("stops (keeping the partial merge) on a transient fetch failure", async () => {
    const assembler = new TraceChunkAssembler();
    seed(assembler, "root", 100_000);
    const { fetchPage, calls } = recorder([
      page([wireEv("a", "root", 100_500)], { startTime: "n", spanId: "a" }, true),
      null,
    ]); // transient failure

    const result = await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(result.merged).toBe(true); // page 1 kept
    expect(result.finished).toBe(false);
    expect(calls).toHaveLength(2);
    expect(assembler.spans.find((s) => s.id === "a")).toBeDefined();
  });

  it("flips a seeded partial span to complete when the tail delivers the completion", async () => {
    const assembler = new TraceChunkAssembler();
    seed(assembler, "root", 100_000, "PARTIAL");
    expect(assembler.spans.find((s) => s.id === "root")?.data.isPartial).toBe(true);
    const { fetchPage } = recorder([
      page([wireEv("root", "", 190_000, { status: "OK", duration: 900 })], null, false),
    ]);

    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(assembler.spans.find((s) => s.id === "root")?.data.isPartial).toBe(false);
  });

  it("stops and reports truncation when the merge crosses the view ceiling", async () => {
    const assembler = new TraceChunkAssembler();
    seed(assembler, "root", 100_000); // size 1
    const { fetchPage, calls } = recorder([
      page(
        [wireEv("a", "root", 100_500), wireEv("b", "root", 100_600)],
        { startTime: "n", spanId: "b" },
        true
      ),
    ]);

    const result = await runTailLoop(fetchPage, assembler, 2, OVERLAP_MS);

    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(1); // stopped after crossing the ceiling
  });

  it("reaches back to the pinned first-read time, not the newest loaded row", async () => {
    const assembler = new TraceChunkAssembler();
    assembler.pinTailFloor(100_000); // first chunk read at 100_000
    seed(assembler, "root", 160_000); // background load ends with a row at 160_000
    const { fetchPage, calls } = recorder([page([], null, false)]);

    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(calls[0].insertedAtSince).toBe(100_000 - OVERLAP_MS);
  });

  it("releases the pinned floor after a clean tick", async () => {
    const assembler = new TraceChunkAssembler();
    assembler.pinTailFloor(100_000);
    seed(assembler, "root", 160_000);
    const { fetchPage, calls } = recorder([
      page([], null, false, 200_000),
      page([], null, false, 210_000),
    ]);

    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);
    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(calls[1].insertedAtSince).toBe(200_000 - OVERLAP_MS);
  });

  it("starts the next tick from the first page's read time, not a later page's rows", async () => {
    const assembler = new TraceChunkAssembler();
    seed(assembler, "root", 100_000);
    const { fetchPage, calls } = recorder([
      page([wireEv("a", "root", 199_000)], { startTime: "n", spanId: "a" }, true, 200_000),
      page([wireEv("b", "root", 202_900)], null, false, 203_000),
      page([], null, false, 210_000),
    ]);

    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);
    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(calls[2].insertedAtSince).toBe(200_000 - OVERLAP_MS);
  });

  it("moves forward on a quiet trace that returned no rows", async () => {
    const assembler = new TraceChunkAssembler();
    seed(assembler, "root", 100_000);
    const { fetchPage, calls } = recorder([
      page([], null, false, 500_000),
      page([], null, false, 505_000),
    ]);

    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);
    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(calls[1].insertedAtSince).toBe(500_000 - OVERLAP_MS);
  });

  it("re-reads from the same point after a failed page, even if an earlier page advanced the high-water", async () => {
    const assembler = new TraceChunkAssembler();
    seed(assembler, "root", 100_000);
    const { fetchPage, calls } = recorder([
      page([wireEv("a", "root", 700_000)], { startTime: "n", spanId: "a" }, true),
      null,
      page([], null, false),
    ]);

    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);
    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(calls[2].insertedAtSince).toBe(100_000 - OVERLAP_MS);
  });

  it("does not tail a store without write times even with a pinned floor", async () => {
    const assembler = new TraceChunkAssembler();
    assembler.pinTailFloor(100_000);
    const { fetchPage, calls } = recorder([]);

    await runTailLoop(fetchPage, assembler, 1000, OVERLAP_MS);

    expect(calls).toHaveLength(0);
  });
});
