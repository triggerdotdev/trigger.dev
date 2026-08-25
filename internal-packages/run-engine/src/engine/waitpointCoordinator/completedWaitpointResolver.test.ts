import type { CompletedWaitpointRecord } from "@internal/run-store";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it } from "vitest";
import {
  createCompletedWaitpointResolver,
  UnresolvableWaitpointId,
} from "./completedWaitpointResolver.js";

function record(overrides: Partial<CompletedWaitpointRecord> = {}): CompletedWaitpointRecord {
  return {
    id: "wp_1",
    friendlyId: "waitpoint_wp_1",
    type: "MANUAL",
    completedAt: "2026-08-25T00:00:00.000Z",
    outputType: "application/json",
    outputIsError: false,
    output: { inline: '{"ok":true}' },
    ...overrides,
  };
}

const noRunOutput = { readRunOutput: async () => undefined };

function resolver(readRunOutput?: (taskRunId: string) => Promise<string | undefined>) {
  return createCompletedWaitpointResolver(readRunOutput ? { readRunOutput } : noRunOutput);
}

const CYCLE = { cycleSeq: 1, count: 0 };

describe("the index expansion", () => {
  it("emits one entry per position of the id in the order", async () => {
    const result = await resolver()({
      runId: "run_1",
      pointer: { cycleSeq: 1, count: 2 },
      order: ["wp_1", "wp_1"],
      records: [record()],
    });

    expect(result).toHaveLength(2);
    expect(result.map((w) => w.index)).toEqual([0, 1]);
  });

  it("gives a run at two batch indexes its two real positions", async () => {
    const result = await resolver()({
      runId: "run_1",
      pointer: { cycleSeq: 1, count: 3 },
      order: ["wp_other", "wp_1", "wp_1"],
      records: [record(), record({ id: "wp_other", friendlyId: "waitpoint_wp_other" })],
    });

    expect(result.filter((w) => w.id === "wp_1").map((w) => w.index)).toEqual([1, 2]);
  });

  // Every wait.for, every single triggerAndWait and every token has no batch index, so it
  // is absent from the order. Dropping it here loses the run's results on resume.
  it("keeps a record with no position, with an undefined index", async () => {
    const result = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record()],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.index).toBeUndefined();
  });

  it("keeps an index-less record alongside an indexed one", async () => {
    const result = await resolver()({
      runId: "run_1",
      pointer: { cycleSeq: 1, count: 1 },
      order: ["wp_indexed"],
      records: [record(), record({ id: "wp_indexed", friendlyId: "waitpoint_wp_indexed" })],
    });

    expect(result).toHaveLength(2);
    expect(result.find((w) => w.id === "wp_1")?.index).toBeUndefined();
    expect(result.find((w) => w.id === "wp_indexed")?.index).toBe(0);
  });
});

describe("the executor shape", () => {
  it("reproduces the scalar fields", async () => {
    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ idempotencyKey: "user-key" })],
    });

    expect(entry).toMatchObject({
      id: "wp_1",
      friendlyId: "waitpoint_wp_1",
      type: "MANUAL",
      completedAt: new Date("2026-08-25T00:00:00.000Z"),
      idempotencyKey: "user-key",
      output: '{"ok":true}',
      outputType: "application/json",
      outputIsError: false,
    });
  });

  it("builds completedByTaskRun for a RUN record", async () => {
    const childRunId = RunId.fromFriendlyId(RunId.generate().friendlyId);

    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ type: "RUN", completedByTaskRunId: childRunId, output: null })],
    });

    expect(entry?.completedByTaskRun).toEqual({
      id: childRunId,
      friendlyId: RunId.toFriendlyId(childRunId),
    });
  });

  // The cycle is minted once, but a later entry in the resume chain can be read under a
  // different batch. The batch shown must be the reading entry's, never the minting one's.
  it("takes batch{} from the reading entry's batchId", async () => {
    const childRunId = RunId.fromFriendlyId(RunId.generate().friendlyId);
    const batchId = BatchId.fromFriendlyId(BatchId.generate().friendlyId);

    const [entry] = await resolver()({
      runId: "run_1",
      batchId,
      pointer: CYCLE,
      order: [],
      records: [record({ type: "RUN", completedByTaskRunId: childRunId, output: null })],
    });

    expect(entry?.completedByTaskRun?.batch).toEqual({
      id: batchId,
      friendlyId: BatchId.toFriendlyId(batchId),
    });
  });

  it("omits batch{} when the reading entry has no batch", async () => {
    const childRunId = RunId.fromFriendlyId(RunId.generate().friendlyId);

    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ type: "RUN", completedByTaskRunId: childRunId, output: null })],
    });

    expect(entry?.completedByTaskRun?.batch).toBeUndefined();
  });

  it("builds completedByBatch for a BATCH record", async () => {
    const batchId = BatchId.fromFriendlyId(BatchId.generate().friendlyId);

    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ type: "BATCH", completedByBatchId: batchId, output: null })],
    });

    expect(entry?.completedByBatch).toEqual({
      id: batchId,
      friendlyId: BatchId.toFriendlyId(batchId),
    });
  });

  it("carries completedAfter as a Date", async () => {
    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ type: "DATETIME", completedAfter: "2026-08-26T00:00:00.000Z" })],
    });

    expect(entry?.completedAfter).toEqual(new Date("2026-08-26T00:00:00.000Z"));
  });
});

describe("the output hydration", () => {
  it("returns an inline value as-is", async () => {
    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ output: { inline: '{"v":1}' } })],
    });

    expect(entry?.output).toBe('{"v":1}');
  });

  it("returns a ref as the output, so the executor resolves it the existing way", async () => {
    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ output: { ref: "store-key-1" }, outputType: "application/store" })],
    });

    expect(entry?.output).toBe("store-key-1");
  });

  it("reads a deriveFromRun output from the run", async () => {
    const [entry] = await resolver(async (id) =>
      id === "run_child" ? '{"derived":true}' : undefined
    )({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [
        record({ type: "RUN", completedByTaskRunId: "run_child", output: { deriveFromRun: true } }),
      ],
    });

    expect(entry?.output).toBe('{"derived":true}');
  });

  it("leaves the output undefined when the run row is gone", async () => {
    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [
        record({ type: "RUN", completedByTaskRunId: "run_gone", output: { deriveFromRun: true } }),
      ],
    });

    expect(entry?.output).toBeUndefined();
  });

  it("reads the run once for a record that expands to several entries", async () => {
    const reads: string[] = [];
    const result = await resolver(async (id) => {
      reads.push(id);
      return '{"derived":true}';
    })({
      runId: "run_1",
      pointer: { cycleSeq: 1, count: 2 },
      order: ["wp_1", "wp_1"],
      records: [
        record({ type: "RUN", completedByTaskRunId: "run_child", output: { deriveFromRun: true } }),
      ],
    });

    expect(result).toHaveLength(2);
    expect(reads).toEqual(["run_child"]);
  });

  it("leaves the output undefined when the record carries none", async () => {
    const [entry] = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record({ output: null })],
    });

    expect(entry?.output).toBeUndefined();
  });
});

// The id classifier is total and never throws: an unrecognised shape classifies as legacy,
// finds no row, and would otherwise vanish from the resumed run's completed set with no
// error. These are the tests that make that impossible.
describe("the coverage check", () => {
  it("throws when the order names an id no half resolved", async () => {
    await expect(
      resolver()({
        runId: "run_1",
        pointer: { cycleSeq: 1, count: 1 },
        order: ["wp_missing"],
        records: [record()],
      })
    ).rejects.toThrow(UnresolvableWaitpointId);
  });

  it("names the offending id and the reason", async () => {
    const error = await resolver()({
      runId: "run_1",
      pointer: { cycleSeq: 1, count: 1 },
      order: ["wp_missing"],
      records: [record()],
    }).catch((caught: unknown) => caught as UnresolvableWaitpointId);

    expect(error.waitpointId).toBe("wp_missing");
    expect(error.reason).toBe("no-source");
  });

  it("accepts an ordered id that the caller resolved from a row", async () => {
    const result = await resolver()({
      runId: "run_1",
      pointer: { cycleSeq: 1, count: 1 },
      order: ["wp_legacy"],
      records: [record()],
      resolvedElsewhere: ["wp_legacy"],
    });

    expect(result.map((w) => w.id)).toEqual(["wp_1"]);
  });

  it("throws when both halves claim the same id", async () => {
    const error = await resolver()({
      runId: "run_1",
      pointer: CYCLE,
      order: [],
      records: [record()],
      resolvedElsewhere: ["wp_1"],
    }).catch((caught: unknown) => caught as UnresolvableWaitpointId);

    expect(error).toBeInstanceOf(UnresolvableWaitpointId);
    expect(error.waitpointId).toBe("wp_1");
    expect(error.reason).toBe("two-sources");
  });

  it("returns only its own half, leaving the legacy half to the caller", async () => {
    const result = await resolver()({
      runId: "run_1",
      pointer: { cycleSeq: 1, count: 2 },
      order: ["wp_legacy", "wp_1"],
      records: [record()],
      resolvedElsewhere: ["wp_legacy"],
    });

    expect(result.map((w) => w.id)).toEqual(["wp_1"]);
    expect(result[0]?.index).toBe(1);
  });

  it("resolves an empty cycle to nothing", async () => {
    await expect(
      resolver()({ runId: "run_1", pointer: CYCLE, order: [], records: [] })
    ).resolves.toEqual([]);
  });
});
