// The deriveFromRun branch, against a real TaskRun row.
//
// This branch is the resolver's only Postgres read, so it is the one part that cannot be proved
// by a pure test: the claim is that TaskRun.output holds the same string the waitpoint carried,
// and only a real row can settle that. The pure suite covers everything that does not read.
import { postgresTest } from "@internal/testcontainers";
import { markReadReplicaClient, PostgresRunStore } from "@internal/run-store";
import type { CompletedWaitpointRecord } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import {
  createCompletedWaitpointResolver,
  createRunOutputsReader,
  UnresolvableWaitpointId,
} from "./completedWaitpointResolver.js";
import { seedChildRunsWithOutputs, seedChildRunWithOutput } from "./testFixtures/childRun.js";

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
  return createCompletedWaitpointResolver({
    readRunOutputs: createRunOutputsReader(runStore, prisma),
  });
}

/**
 * A resolver that records the id set of every batched read and DELEGATES to the real reader, so
 * the Postgres read still happens.
 *
 * Wrapping the collaborator rather than replacing it is deliberate: the assertion is about how
 * many reads occur and what they ask for, and neither is observable from the resolved output.
 */
function countingResolver(prisma: PrismaClient) {
  const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const read = createRunOutputsReader(runStore, prisma);
  const batches: string[][] = [];

  return {
    batches,
    resolve: createCompletedWaitpointResolver({
      readRunOutputs: async (ids) => {
        batches.push(ids);
        return read(ids);
      },
    }),
  };
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

  // A record that DEFERS to a run whose output is gone still refuses -- that is the case the
  // refusal exists for, and the record only defers when the waitpoint carried an output.
  //
  // This is deliberately reached by hand-building a derive record for an output-less run, a shape
  // chooseOutput no longer produces. An earlier revision produced it for every non-error RUN
  // waitpoint, which refused the resume of any task that returns nothing; the test below pins
  // that case, and this one keeps the refusal itself honest.
  postgresTest("refuses when a derive record's run output is gone", async ({ prisma }) => {
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
    const { resolve, batches } = countingResolver(prisma);

    const result = await resolve({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 2 },
      order: ["wp_run", "wp_run"],
      distinctIds: ["wp_run"],
      records: [deriveRecord(runId)],
    });

    expect(result).toHaveLength(2);
    expect(batches).toEqual([[runId]]);
  });

  // The shape a batch fan-in produces. Every deferring record resolves in ONE read, not one
  // read each: a per-record read put a serial round trip per child on the resume path, which is
  // the cost the record set exists to remove.
  postgresTest("reads every deferred run in one batch", async ({ prisma }) => {
    const runIds = await seedChildRunsWithOutputs(
      prisma,
      Array.from({ length: 12 }, (_, i) => `{"value":${i}}`)
    );
    const { resolve, batches } = countingResolver(prisma);

    const records = runIds.map((runId, i) => ({
      ...deriveRecord(runId),
      id: `wp_run_${i}`,
      friendlyId: `waitpoint_wp_run_${i}`,
    }));

    const result = await resolve({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: records.length },
      order: records.map((r) => r.id),
      distinctIds: records.map((r) => r.id),
      records,
    });

    expect(result).toHaveLength(12);
    // One batch, holding every distinct run id.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.slice().sort()).toEqual(runIds.slice().sort());
    // And each output landed on its own waitpoint.
    for (const [i, runId] of runIds.entries()) {
      const entry = result.find((w) => w.id === `wp_run_${i}`);
      expect(entry?.output).toBe(`{"value":${i}}`);
      expect(runId).toBeTruthy();
    }
  });

  // An empty string is a VALUE, not an absence. The reader's `row.output !== null` is what keeps
  // it: narrowed to a truthy test it would report the run as output-less and throw
  // lost-run-output on a run that completed perfectly well. Nothing else pins that, and
  // `chooseOutput` already treats empty as a value on the write side.
  postgresTest("keeps an empty-string output rather than refusing", async ({ prisma }) => {
    const runId = await seedChildRunWithOutput(prisma, "");

    const [entry] = await resolverFor(prisma)({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 0 },
      order: [],
      distinctIds: ["wp_run"],
      records: [deriveRecord(runId)],
    });

    expect(entry?.output).toBe("");
  });

  // Two waitpoints completed by the SAME run. One id in one batch, and both entries carry it:
  // the dedup must not cost the second waitpoint its output.
  postgresTest("reads a shared run once and hydrates both waitpoints", async ({ prisma }) => {
    const runId = await seedChildRunWithOutput(prisma, '{"shared":true}');
    const { resolve, batches } = countingResolver(prisma);

    const result = await resolve({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 2 },
      order: ["wp_first", "wp_second"],
      distinctIds: ["wp_first", "wp_second"],
      records: [
        { ...deriveRecord(runId), id: "wp_first", friendlyId: "waitpoint_wp_first" },
        { ...deriveRecord(runId), id: "wp_second", friendlyId: "waitpoint_wp_second" },
      ],
    });

    expect(batches).toEqual([[runId]]);
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.output)).toEqual(['{"shared":true}', '{"shared":true}']);
  });

  // A cycle that defers nothing reads nothing, so an all-inline resume pays no Postgres round
  // trip at all.
  postgresTest("reads nothing when no record defers", async ({ prisma }) => {
    const { resolve, batches } = countingResolver(prisma);

    const result = await resolve({
      runId: "run_parent",
      pointer: { cycleSeq: 1, count: 0 },
      order: [],
      distinctIds: ["wp_inline"],
      records: [
        {
          ...deriveRecord("run_unused"),
          id: "wp_inline",
          friendlyId: "waitpoint_wp_inline",
          output: { inline: '{"ok":true}' },
        },
      ],
    });

    expect(result[0]?.output).toBe('{"ok":true}');
    expect(batches).toEqual([]);
  });

  // The required-writer rule is a runtime check because it cannot be a type one: ReadClient admits
  // a writer and a replica, and they are structurally identical apart from the brand.
  postgresTest("refuses to be built with a replica client", async ({ prisma }) => {
    const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const replica = markReadReplicaClient({ ...prisma });

    expect(() => createRunOutputsReader(runStore, replica as never)).toThrow(/needs a writer/);
  });

  // The one place the design could fail OPEN instead of loud: a derive marker with no run to
  // derive from would otherwise resolve the waitpoint with no output and no error.
  postgresTest("throws on a derive record carrying no run id", async ({ prisma }) => {
    const { id: _drop, ...rest } = deriveRecord("run_unused");

    await expect(
      resolverFor(prisma)({
        runId: "run_parent",
        pointer: { cycleSeq: 1, count: 0 },
        order: [],
        distinctIds: ["wp_run"],
        records: [{ ...rest, id: "wp_run", completedByTaskRunId: undefined }],
      })
    ).rejects.toThrow(/carries no run id/);
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
