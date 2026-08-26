// The resolver must produce what the executor already consumes, so the oracle is the
// existing hydration and not a hand-written literal. A literal cannot catch a drift in
// enhanceExecutionSnapshotWithWaitpoints itself; this can.
import type { Waitpoint } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { enhanceExecutionSnapshotWithWaitpoints } from "../systems/executionSnapshotSystem.js";
import { buildCompletedWaitpointRecords } from "./completedWaitpointRecords.js";
import { createCompletedWaitpointResolver } from "./completedWaitpointResolver.js";
import { envelopeSourceFromWaitpointRow } from "./completionEnvelopeSource.js";
import type { CompletionEnvelopeSource } from "./types.js";

const COMPLETED_AT = new Date("2026-08-25T00:00:00.000Z");
const RUN_ID = "run_0123456789abcdefghijklm";
const CHILD_RUN_ID = "run_zyxwvutsrqponmlkjihgfe";
const BATCH_ID = "batch_0123456789abcdefghijk";

/**
 * One waitpoint, in both shapes, from one description. Keeping them in one factory is what
 * makes the comparison meaningful: a field added to only one shape shows up as a diff.
 */
function pair(overrides: {
  id: string;
  type: Waitpoint["type"];
  output?: string | null;
  outputType?: string;
  outputIsError?: boolean;
  completedByTaskRunId?: string | null;
  completedByBatchId?: string | null;
  completedAfter?: Date | null;
  idempotencyKey?: string;
  userProvidedIdempotencyKey?: boolean;
  inactiveIdempotencyKey?: string | null;
}): { row: Waitpoint; source: CompletionEnvelopeSource } {
  const row = {
    id: overrides.id,
    friendlyId: `waitpoint_${overrides.id}`,
    type: overrides.type,
    status: "COMPLETED",
    completedAt: COMPLETED_AT,
    output: overrides.output ?? null,
    outputType: overrides.outputType ?? "application/json",
    outputIsError: overrides.outputIsError ?? false,
    completedByTaskRunId: overrides.completedByTaskRunId ?? null,
    completedByBatchId: overrides.completedByBatchId ?? null,
    completedAfter: overrides.completedAfter ?? null,
    idempotencyKey: overrides.idempotencyKey ?? "internal",
    userProvidedIdempotencyKey: overrides.userProvidedIdempotencyKey ?? false,
    inactiveIdempotencyKey: overrides.inactiveIdempotencyKey ?? null,
  } as unknown as Waitpoint;

  // Through the SHARED mapper the legacy arm uses. A hand-rolled copy here would make a bug in
  // that arm invisible to every case below, because the oracle chain would never touch it.
  return { row, source: envelopeSourceFromWaitpointRow(row) };
}

function snapshot(batchId: string | null) {
  return { id: "snap_1", runId: RUN_ID, batchId } as never;
}

function sortEntries<T extends { id: string; index?: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id) || (a.index ?? -1) - (b.index ?? -1));
}

/**
 * Run one description through both paths and assert the results match.
 *
 * `deriveFromRun` is the one case where the two paths cannot be identical by construction:
 * the row carries the value and the record carries a marker. Feeding the row's own output
 * back as the run's output is what makes them comparable, which is exactly the claim the
 * variant makes — that TaskRun.output holds the same string.
 */
async function bothPaths(
  pairs: ReturnType<typeof pair>[],
  order: string[],
  batchId: string | null = null
) {
  const outputsByRunId = new Map<string, string>();
  for (const { row } of pairs) {
    if (row.completedByTaskRunId && row.output !== null) {
      outputsByRunId.set(row.completedByTaskRunId, row.output);
    }
  }

  const expected = enhanceExecutionSnapshotWithWaitpoints(
    snapshot(batchId),
    pairs.map((p) => p.row),
    order
  ).completedWaitpoints;

  const actual = await createCompletedWaitpointResolver({
    readRunOutput: async (taskRunId) => outputsByRunId.get(taskRunId),
  })({
    runId: RUN_ID,
    ...(batchId ? { batchId } : {}),
    pointer: { cycleSeq: 1, count: order.length },
    order,
    distinctIds: [...new Set(pairs.map((p) => p.row.id))],
    records: buildCompletedWaitpointRecords(pairs.map((p) => p.source)),
  });

  return { expected: sortEntries(expected), actual: sortEntries(actual) };
}

describe("the resolver reproduces the existing hydration", () => {
  it("for a single MANUAL waitpoint with an inline output", async () => {
    const { expected, actual } = await bothPaths(
      [pair({ id: "wp_manual", type: "MANUAL", output: '{"token":1}' })],
      []
    );

    expect(actual).toEqual(expected);
  });

  it("for a MANUAL waitpoint with a user-provided idempotency key", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_manual",
          type: "MANUAL",
          output: '{"token":1}',
          idempotencyKey: "user-key",
          userProvidedIdempotencyKey: true,
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
    expect(actual[0]?.idempotencyKey).toBe("user-key");
  });

  it("for an idempotency key the user provided but that went inactive", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_manual",
          type: "MANUAL",
          output: '{"token":1}',
          idempotencyKey: "user-key",
          userProvidedIdempotencyKey: true,
          inactiveIdempotencyKey: "old",
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
    expect(actual[0]?.idempotencyKey).toBeUndefined();
  });

  it("for a DATETIME waitpoint", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_datetime",
          type: "DATETIME",
          completedAfter: new Date("2026-08-26T00:00:00.000Z"),
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
  });

  it("for a RUN waitpoint outside a batch", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: CHILD_RUN_ID,
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
  });

  it("for a RUN waitpoint read under a batch", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: CHILD_RUN_ID,
        }),
      ],
      ["wp_run"],
      BATCH_ID
    );

    expect(actual).toEqual(expected);
    expect(actual[0]?.completedByTaskRun?.batch?.id).toBe(BATCH_ID);
  });

  it("for a RUN waitpoint whose output is an error", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"message":"boom"}',
          outputIsError: true,
          completedByTaskRunId: CHILD_RUN_ID,
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
  });

  it("for a BATCH waitpoint", async () => {
    const { expected, actual } = await bothPaths(
      [pair({ id: "wp_batch", type: "BATCH", completedByBatchId: BATCH_ID })],
      []
    );

    expect(actual).toEqual(expected);
  });

  it("for an already-offloaded output", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_manual",
          type: "MANUAL",
          output: "store-key-1",
          outputType: "application/store",
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
  });

  // The case the suite was blind to, and the one the frozen reference orders the other way. The
  // oracle emits the ref string; so does this, by a different branch.
  it("for an offloaded RUN success", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_run_ref",
          type: "RUN",
          output: "s3://bucket/key",
          outputType: "application/store",
          completedByTaskRunId: CHILD_RUN_ID,
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
    expect(actual[0]?.output).toBe("s3://bucket/key");
  });

  it("for one run present at two batch indexes", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: CHILD_RUN_ID,
        }),
      ],
      ["wp_run", "wp_run"],
      BATCH_ID
    );

    expect(actual).toEqual(expected);
    expect(actual.map((w) => w.index)).toEqual([0, 1]);
  });

  it("for an index-less waitpoint sitting beside indexed ones", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({ id: "wp_indexless", type: "MANUAL", output: '{"token":1}' }),
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: CHILD_RUN_ID,
        }),
      ],
      ["wp_run"],
      BATCH_ID
    );

    expect(actual).toEqual(expected);
    expect(actual.find((w) => w.id === "wp_indexless")?.index).toBeUndefined();
  });

  // The ONE intentional divergence from the oracle. A BATCH waitpoint really is completed with
  // an output, but the executor never reads it (sharedRuntimeManager.resolveWaitpoint
  // early-returns on type). Pinned so that if that early return ever goes away, this fails and
  // says why, instead of the output silently being missing at resume.
  it("deliberately drops a BATCH output, unlike the oracle", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_batch",
          type: "BATCH",
          completedByBatchId: BATCH_ID,
          output: '{"message":"batch expired"}',
          outputIsError: true,
        }),
      ],
      []
    );

    expect(expected[0]?.output).toBe('{"message":"batch expired"}');
    expect(actual[0]?.output).toBeUndefined();
    expect(actual[0]?.outputIsError).toBe(true);
  });

  it("for every type at once, under a batch", async () => {
    const { expected, actual } = await bothPaths(
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: CHILD_RUN_ID,
        }),
        pair({ id: "wp_batch", type: "BATCH", completedByBatchId: BATCH_ID }),
        pair({
          id: "wp_datetime",
          type: "DATETIME",
          completedAfter: new Date("2026-08-26T00:00:00.000Z"),
        }),
        pair({
          id: "wp_manual",
          type: "MANUAL",
          output: '{"token":1}',
          idempotencyKey: "user-key",
          userProvidedIdempotencyKey: true,
        }),
      ],
      ["wp_run", "wp_batch", "wp_datetime"],
      BATCH_ID
    );

    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(4);
  });
});
