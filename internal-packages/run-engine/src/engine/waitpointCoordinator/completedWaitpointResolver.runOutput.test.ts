// The deriveFromRun branch, against a real TaskRun row.
//
// This branch is the resolver's only Postgres read, so it is the one part that cannot be proved
// by a pure test: the claim is that TaskRun.output holds the same string the waitpoint carried,
// and only a real row can settle that. The pure suite covers everything that does not read.
import { postgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { CompletedWaitpointRecord } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import {
  createCompletedWaitpointResolver,
  createRunOutputReader,
  UnresolvableWaitpointId,
} from "./completedWaitpointResolver.js";
import { seedChildRunWithOutput } from "./testFixtures/childRun.js";

function deriveRecord(completedByTaskRunId: string): CompletedWaitpointRecord {
  return {
    id: "wp_run",
    friendlyId: "waitpoint_wp_run",
    type: "RUN",
    completedAt: "2026-08-26T00:00:00.000Z",
    outputType: "application/json",
    outputIsError: false,
    output: { deriveFromRun: true },
    completedByTaskRunId,
  };
}

function resolverFor(prisma: PrismaClient) {
  const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return createCompletedWaitpointResolver({ readRunOutput: createRunOutputReader(runStore) });
}

describe("the deriveFromRun branch", () => {
  postgresTest("reads the completing run's output verbatim", async ({ prisma }) => {
    const stored = '{"value":42,"nested":{"a":[1,2,3]}}';
    const runId = await seedChildRunWithOutput(prisma, stored);

    const [entry] = await resolverFor(prisma)({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 0 },
      order: [],
      distinctIds: ["wp_run"],
      records: [deriveRecord(runId)],
    });

    // Byte-identical, which is the whole premise of the variant.
    expect(entry?.output).toBe(stored);
  });

  postgresTest("carries an offloaded ref through unchanged", async ({ prisma }) => {
    const runId = await seedChildRunWithOutput(prisma, "s3://bucket/key");

    const [entry] = await resolverFor(prisma)({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 0 },
      order: [],
      distinctIds: ["wp_run"],
      records: [deriveRecord(runId)],
    });

    expect(entry?.output).toBe("s3://bucket/key");
  });

  // The run row disappearing between the record write and the read. Postgres does not lose the
  // value on the legacy path, so resolving empty here would resolve a triggerAndWait with
  // silently wrong data.
  postgresTest("refuses when the completing run is gone", async ({ prisma }) => {
    const runId = await seedChildRunWithOutput(prisma, '{"value":42}');
    await prisma.taskRun.delete({ where: { id: runId } });

    const failure = await resolverFor(prisma)({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 0 },
      order: [],
      distinctIds: ["wp_run"],
      records: [deriveRecord(runId)],
    }).catch((caught: unknown) => caught as UnresolvableWaitpointId);

    expect(failure).toBeInstanceOf(UnresolvableWaitpointId);
    expect(failure.reason).toBe("lost-run-output");
  });

  postgresTest("refuses when the run exists with no output", async ({ prisma }) => {
    const runId = await seedChildRunWithOutput(prisma, null);

    const failure = await resolverFor(prisma)({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 0 },
      order: [],
      distinctIds: ["wp_run"],
      records: [deriveRecord(runId)],
    }).catch((caught: unknown) => caught as UnresolvableWaitpointId);

    expect(failure).toBeInstanceOf(UnresolvableWaitpointId);
    expect(failure.reason).toBe("lost-run-output");
  });

  // One read per record, not one per position, so a run at several batch indexes does not pay a
  // query per index.
  postgresTest("reads the run once for a record at several indexes", async ({ prisma }) => {
    const runId = await seedChildRunWithOutput(prisma, '{"value":42}');
    const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const reads: string[] = [];
    const reader = createRunOutputReader(runStore);

    // Counts calls and DELEGATES to the real reader, so the Postgres read still happens. This
    // wraps the collaborator rather than replacing it: the assertion is about how many reads
    // occur, which is not observable from the resolved output alone.
    const result = await createCompletedWaitpointResolver({
      readRunOutput: async (id) => {
        reads.push(id);
        return reader(id);
      },
    })({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 2 },
      order: ["wp_run", "wp_run"],
      distinctIds: ["wp_run"],
      records: [deriveRecord(runId)],
    });

    expect(result).toHaveLength(2);
    expect(reads).toEqual([runId]);
  });

  postgresTest("throws when a derive record arrives with no reader wired", async ({ prisma }) => {
    const runId = await seedChildRunWithOutput(prisma, '{"value":42}');

    await expect(
      createCompletedWaitpointResolver({})({
        runId: "run_parent",
        pointer: { cycleSeq: 1, count: 0 },
        order: [],
        distinctIds: ["wp_run"],
        records: [deriveRecord(runId)],
      })
    ).rejects.toThrow(/no run-output reader/);
  });
});
