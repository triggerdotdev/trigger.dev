// The resolver must produce what the executor already consumes, so the oracle is the
// existing hydration and not a hand-written literal. A literal cannot catch a drift in
// enhanceExecutionSnapshotWithWaitpoints itself; this can.
import { postgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { seedChildRunsWithOutputs, seedChildRunWithOutput } from "./testFixtures/childRun.js";
import { enhanceExecutionSnapshotWithWaitpoints } from "../systems/executionSnapshotSystem.js";
import { buildCompletedWaitpointRecords } from "./completedWaitpointRecords.js";
import {
  createCompletedWaitpointResolver,
  createRunOutputsReader,
} from "./completedWaitpointResolver.js";
import { envelopeSourceFromWaitpointRow } from "./completionEnvelopeSource.js";
import type { CompletionEnvelopeSource } from "./types.js";

const COMPLETED_AT = new Date("2026-08-25T00:00:00.000Z");
const RUN_ID = "run_0123456789abcdefghijklm";
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
  prisma: PrismaClient,
  pairs: ReturnType<typeof pair>[],
  order: string[],
  batchId: string | null = null
) {
  const expected = enhanceExecutionSnapshotWithWaitpoints(
    snapshot(batchId),
    pairs.map((p) => p.row),
    order
  ).completedWaitpoints;

  const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

  const actual = await createCompletedWaitpointResolver({
    readRunOutputs: createRunOutputsReader(runStore, prisma),
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
  postgresTest("for a single MANUAL waitpoint with an inline output", async ({ prisma }) => {
    const { expected, actual } = await bothPaths(
      prisma,
      [pair({ id: "wp_manual", type: "MANUAL", output: '{"token":1}' })],
      []
    );

    expect(actual).toEqual(expected);
  });

  postgresTest(
    "for a MANUAL waitpoint with a user-provided idempotency key",
    async ({ prisma }) => {
      const { expected, actual } = await bothPaths(
        prisma,
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
    }
  );

  postgresTest(
    "for an idempotency key the user provided but that went inactive",
    async ({ prisma }) => {
      const { expected, actual } = await bothPaths(
        prisma,
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
    }
  );

  postgresTest("for a DATETIME waitpoint", async ({ prisma }) => {
    const { expected, actual } = await bothPaths(
      prisma,
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

  postgresTest("for a RUN waitpoint outside a batch", async ({ prisma }) => {
    const childRunId = await seedChildRunWithOutput(prisma, '{"ok":true}');
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: childRunId,
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
  });

  // Two deferring records in ONE cycle, which is the shape a batch fan-in produces and the one
  // the batched read introduced. Every other case here defers at most once, so a mis-keyed map
  // or a swapped output would compare equal against the oracle in all of them.
  //
  // The outputs differ deliberately, and one run sits at two interleaved positions, so a swap
  // between the two runs and a lost second position both show up as a diff.
  postgresTest("for two RUN waitpoints deferring to different runs", async ({ prisma }) => {
    const [runA, runB] = await seedChildRunsWithOutputs(prisma, ['{"child":"a"}', '{"child":"b"}']);

    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run_a",
          type: "RUN",
          output: '{"child":"a"}',
          completedByTaskRunId: runA,
        }),
        pair({
          id: "wp_run_b",
          type: "RUN",
          output: '{"child":"b"}',
          completedByTaskRunId: runB,
        }),
      ],
      ["wp_run_a", "wp_run_b", "wp_run_a"],
      BATCH_ID
    );

    expect(actual).toEqual(expected);
    // Stated as well as compared: the oracle agreeing is the assertion, but a reader should not
    // have to run it to see that three entries come back and each output landed on its own id.
    expect(actual).toHaveLength(3);
    expect(actual.filter((w) => w.id === "wp_run_a").map((w) => w.output)).toEqual([
      '{"child":"a"}',
      '{"child":"a"}',
    ]);
    expect(actual.find((w) => w.id === "wp_run_b")?.output).toBe('{"child":"b"}');
  });

  // A child that returned nothing. The oracle emits `output: w.output ?? undefined`, i.e. resumes
  // with no output; an earlier revision marked this derivable, read a null TaskRun.output and
  // refused the resume outright. Comparing against the oracle is what makes that a failure rather
  // than a design choice, so the case belongs here and not only in the unit suite.
  postgresTest("for a RUN waitpoint whose child returned no output", async ({ prisma }) => {
    const childRunId = await seedChildRunWithOutput(prisma, null);
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run_void",
          type: "RUN",
          output: null,
          completedByTaskRunId: childRunId,
        }),
      ],
      ["wp_run_void"]
    );

    expect(actual).toEqual(expected);
    expect(actual[0]?.output).toBeUndefined();
  });

  postgresTest("for a RUN waitpoint read under a batch", async ({ prisma }) => {
    const childRunId = await seedChildRunWithOutput(prisma, '{"ok":true}');
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: childRunId,
        }),
      ],
      ["wp_run"],
      BATCH_ID
    );

    expect(actual).toEqual(expected);
    expect(actual[0]?.completedByTaskRun?.batch?.id).toBe(BATCH_ID);
  });

  postgresTest("for a RUN waitpoint whose output is an error", async ({ prisma }) => {
    const childRunId = await seedChildRunWithOutput(prisma, '{"message":"boom"}');
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"message":"boom"}',
          outputIsError: true,
          completedByTaskRunId: childRunId,
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
  });

  postgresTest("for a BATCH waitpoint", async ({ prisma }) => {
    const { expected, actual } = await bothPaths(
      prisma,
      [pair({ id: "wp_batch", type: "BATCH", completedByBatchId: BATCH_ID })],
      []
    );

    expect(actual).toEqual(expected);
  });

  postgresTest("for an already-offloaded output", async ({ prisma }) => {
    const { expected, actual } = await bothPaths(
      prisma,
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
  postgresTest("for an offloaded RUN success", async ({ prisma }) => {
    const childRunId = await seedChildRunWithOutput(prisma, "s3://bucket/key");
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run_ref",
          type: "RUN",
          output: "s3://bucket/key",
          outputType: "application/store",
          completedByTaskRunId: childRunId,
        }),
      ],
      []
    );

    expect(actual).toEqual(expected);
    expect(actual[0]?.output).toBe("s3://bucket/key");
  });

  postgresTest("for one run present at two batch indexes", async ({ prisma }) => {
    const childRunId = await seedChildRunWithOutput(prisma, '{"ok":true}');
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: childRunId,
        }),
      ],
      ["wp_run", "wp_run"],
      BATCH_ID
    );

    expect(actual).toEqual(expected);
    expect(actual.map((w) => w.index)).toEqual([0, 1]);
  });

  postgresTest("for an index-less waitpoint sitting beside indexed ones", async ({ prisma }) => {
    // Seeded to match the RUN row's own output, which is the parity premise: TaskRun.output
    // holds the same string the waitpoint carried.
    const childRunId = await seedChildRunWithOutput(prisma, '{"ok":true}');
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({ id: "wp_indexless", type: "MANUAL", output: '{"token":1}' }),
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: childRunId,
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
  postgresTest("deliberately drops a BATCH output, unlike the oracle", async ({ prisma }) => {
    const { expected, actual } = await bothPaths(
      prisma,
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

  postgresTest("for every type at once, under a batch", async ({ prisma }) => {
    const childRunId = await seedChildRunWithOutput(prisma, '{"ok":true}');
    const { expected, actual } = await bothPaths(
      prisma,
      [
        pair({
          id: "wp_run",
          type: "RUN",
          output: '{"ok":true}',
          completedByTaskRunId: childRunId,
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
