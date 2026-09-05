// The seam: a record set written into a real cycle key, read back out, and resolved.
//
// The two halves were covered separately and the join between them was not, so an envelope built
// in a shape the resolver does not expect survives both suites and fails only here. Envelopes come
// from real Postgres rows through the legacy arm; the oracle is the existing hydration over the
// same rows.
//
// The records field is read with a probe because the read API for it does not exist yet -- that
// hydration belongs to the snapshot-store lane. Everything either side of that read is production
// code.
import { createRedisClient } from "@internal/redis";
import { PostgresRunStore, RedisSnapshotStore, type SnapshotEntryInput } from "@internal/run-store";
import { Logger } from "@trigger.dev/core/logger";
import { generateInternalId, generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient, Waitpoint } from "@trigger.dev/database";
import { containerTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { enhanceExecutionSnapshotWithWaitpoints } from "../systems/executionSnapshotSystem.js";
import { setupAuthenticatedEnvironment } from "../tests/setup.js";
import { buildCompletedWaitpointRecords } from "./completedWaitpointRecords.js";
import {
  createCompletedWaitpointResolver,
  createRunOutputsReader,
  UnresolvableWaitpointId,
} from "./completedWaitpointResolver.js";
import { LegacyPostgresWaitpointCoordinator } from "./legacyPostgresCoordinator.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

function entryFor(runId: string, env: Env): SnapshotEntryInput {
  return {
    id: generateInternalId(),
    engine: "V2",
    executionStatus: "EXECUTING_WITH_WAITPOINTS",
    description: "Run resumed",
    runId,
    runStatus: "EXECUTING",
    createdAt: new Date().toISOString(),
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.project.id,
    organizationId: env.organization.id,
  };
}

// `id` omitted gives Prisma's cuid default, i.e. the legacy format; a minted id gives the store
// format. Both halves of a mixed snapshot come from here so they cannot drift apart.
async function seedWaitpoint(
  prisma: PrismaClient,
  env: Env,
  fields: {
    id?: string;
    output?: string | null;
    outputType?: string;
    completedByTaskRunId?: string;
  }
): Promise<Waitpoint> {
  const key = `idem_${generateInternalId().slice(-16)}`;
  return prisma.waitpoint.create({
    data: {
      ...(fields.id ? { id: fields.id } : {}),
      friendlyId: `waitpoint_${key}`,
      type: fields.completedByTaskRunId ? "RUN" : "MANUAL",
      status: "COMPLETED",
      completedAt: new Date(),
      idempotencyKey: key,
      userProvidedIdempotencyKey: false,
      output: fields.output ?? null,
      outputType: fields.outputType ?? "application/json",
      ...(fields.completedByTaskRunId && { completedByTaskRunId: fields.completedByTaskRunId }),
      projectId: env.project.id,
      environmentId: env.id,
    },
  });
}

async function seedCompletedRun(prisma: PrismaClient, env: Env, output: string): Promise<string> {
  const suffix = generateInternalId().slice(-12);
  const run = await prisma.taskRun.create({
    data: {
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: `run_child${suffix}`,
      runtimeEnvironmentId: env.id,
      environmentType: env.type,
      organizationId: env.organization.id,
      projectId: env.project.id,
      taskIdentifier: "child-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${suffix}`,
      spanId: `span_${suffix}`,
      queue: "task/child-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 1,
      output,
      outputType: "application/json",
    },
    select: { id: true },
  });
  return run.id;
}

type Harness = {
  runId: string;
  store: RedisSnapshotStore;
  probe: ReturnType<typeof createRedisClient>;
  coordinator: LegacyPostgresWaitpointCoordinator;
  resolve: ReturnType<typeof createCompletedWaitpointResolver>;
  runStore: PostgresRunStore;
};

function harness(prisma: PrismaClient, redisOptions: never): Harness {
  const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return {
    runId: generateInternalId(),
    store: new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS }),
    probe: createRedisClient(redisOptions, { onError: () => {} }),
    coordinator: new LegacyPostgresWaitpointCoordinator({
      runStore: runStore as never,
      prisma,
      logger: new Logger("roundtrip", "error"),
    }),
    resolve: createCompletedWaitpointResolver({
      readRunOutputs: createRunOutputsReader(runStore, prisma),
    }),
    runStore,
  };
}

// Envelopes from rows, records into the cycle key, id lists back out through the store's read,
// then resolve. Returns the resolver's answer beside the oracle's for the same rows.
async function roundTrip(
  h: Harness,
  env: Env,
  rows: Waitpoint[],
  order: string[],
  storeFormatIds: string[]
) {
  const refs = rows.map((row) => {
    const index = order.indexOf(row.id);
    return index === -1 ? { id: row.id } : { id: row.id, index };
  });
  // Every position, not just the first: a run at two batch indexes must keep both.
  const withRepeats = order.flatMap((id, index) =>
    refs.some((r) => r.id === id) ? [{ id, index }] : []
  );
  const completedWaitpoints = [
    ...withRepeats,
    ...refs.filter((r) => r.index === undefined).map((r) => ({ id: r.id })),
  ];

  // Production envelope build, over real rows, through the arm the engine actually constructs.
  const sources = await h.coordinator.readCompletionEnvelopes({
    runId: h.runId,
    waitpointIds: storeFormatIds,
  });
  const records = buildCompletedWaitpointRecords(sources);

  const appended = await h.store.append({
    entry: entryFor(h.runId, env),
    kind: "birth",
    isTerminal: false,
    cycle: { kind: "new", completedWaitpoints, records },
  });
  expect(appended.outcome).toBe("written");

  // Back out through the store's own read, not through the objects we just wrote.
  const read = await h.store.getLatest(h.runId);
  expect(read?.cycle).toBeDefined();
  expect(read?.danglingCycle).toBeFalsy();

  const raw = await h.probe.hget(`snap:{${h.runId}}:wp:${read!.cycle!.cycleSeq}`, "records");
  const storedRecords = raw ? JSON.parse(raw) : [];

  const legacyIds = rows.map((r) => r.id).filter((id) => !storeFormatIds.includes(id));

  const actual = await h.resolve({
    runId: h.runId,
    pointer: read!.cycle!,
    order: read!.completedWaitpointIds?.order ?? [],
    distinctIds: read!.completedWaitpointIds?.distinctIds ?? [],
    records: storedRecords,
    ...(legacyIds.length > 0 && { resolvedElsewhere: legacyIds }),
  });

  const oracle = enhanceExecutionSnapshotWithWaitpoints(
    { id: generateInternalId(), runId: h.runId, batchId: null } as never,
    rows,
    order
  ).completedWaitpoints;

  const sort = <T extends { id: string; index?: number }>(xs: T[]) =>
    [...xs].sort((a, b) => a.id.localeCompare(b.id) || (a.index ?? -1) - (b.index ?? -1));

  return {
    actual: sort(actual),
    // The resolver returns its own half only; the legacy half stays with the caller.
    expected: sort(oracle.filter((w) => storeFormatIds.includes(w.id))),
    storedRecords,
    read,
  };
}

describe("a record set round-trips through the cycle key", () => {
  containerTest("for an inline MANUAL output", async ({ prisma, redisOptions }) => {
    const h = harness(prisma as never, redisOptions as never);
    try {
      const env = await setupAuthenticatedEnvironment(prisma as never, "PRODUCTION");
      const row = await seedWaitpoint(prisma as never, env, {
        id: generateWaitpointId("MANUAL"),
        output: '{"token":1}',
      });

      const { actual, expected, storedRecords } = await roundTrip(
        h,
        env,
        [row],
        [row.id],
        [row.id]
      );

      expect(storedRecords).toHaveLength(1);
      expect(actual).toEqual(expected);
      expect(actual[0]?.output).toBe('{"token":1}');
    } finally {
      await Promise.all([h.store.quit(), h.probe.quit().catch(() => {})]);
    }
  });

  // deriveFromRun is the one place the written record and the resolved entry legitimately
  // differ, so it has to survive the real round trip.
  containerTest("for a RUN output derived from the run row", async ({ prisma, redisOptions }) => {
    const h = harness(prisma as never, redisOptions as never);
    try {
      const env = await setupAuthenticatedEnvironment(prisma as never, "PRODUCTION");
      const childRunId = await seedCompletedRun(prisma as never, env, '{"child":true}');
      const row = await seedWaitpoint(prisma as never, env, {
        id: generateWaitpointId("RUN"),
        output: '{"child":true}',
        completedByTaskRunId: childRunId,
      });

      const { actual, expected, storedRecords } = await roundTrip(
        h,
        env,
        [row],
        [row.id],
        [row.id]
      );

      // The record carries a marker, not the value.
      expect(storedRecords[0]?.output).toEqual({ deriveFromRun: true });
      // And the resolved entry carries the value, byte-identical to the oracle's.
      expect(actual).toEqual(expected);
      expect(actual[0]?.output).toBe('{"child":true}');
    } finally {
      await Promise.all([h.store.quit(), h.probe.quit().catch(() => {})]);
    }
  });

  // Both halves read their index from the same order, so the positions agree with no
  // coordination between them.
  containerTest(
    "for a mixed legacy and store-format snapshot",
    async ({ prisma, redisOptions }) => {
      const h = harness(prisma as never, redisOptions as never);
      try {
        const env = await setupAuthenticatedEnvironment(prisma as never, "PRODUCTION");
        const storeRow = await seedWaitpoint(prisma as never, env, {
          id: generateWaitpointId("MANUAL"),
          output: '{"store":true}',
        });
        // No id: Prisma's cuid default, which is the legacy format.
        const legacyRow = await seedWaitpoint(prisma as never, env, { output: '{"legacy":true}' });

        const order = [legacyRow.id, storeRow.id];
        const { actual, expected, read } = await roundTrip(h, env, [storeRow, legacyRow], order, [
          storeRow.id,
        ]);

        // The store read carries BOTH ids, because the cycle records the whole membership...
        expect(read?.completedWaitpointIds?.order).toEqual(order);
        // ...but the resolver answers for its half only, at its real position.
        expect(actual).toEqual(expected);
        expect(actual).toHaveLength(1);
        expect(actual[0]?.id).toBe(storeRow.id);
        expect(actual[0]?.index).toBe(1);
      } finally {
        await Promise.all([h.store.quit(), h.probe.quit().catch(() => {})]);
      }
    }
  );

  // Repeats live in the order, never in the record set, so this pins that the round trip does
  // not collapse them.
  containerTest("for one waitpoint at two batch indexes", async ({ prisma, redisOptions }) => {
    const h = harness(prisma as never, redisOptions as never);
    try {
      const env = await setupAuthenticatedEnvironment(prisma as never, "PRODUCTION");
      const row = await seedWaitpoint(prisma as never, env, {
        id: generateWaitpointId("RUN"),
        output: '{"twice":true}',
      });

      const { actual, expected, storedRecords } = await roundTrip(
        h,
        env,
        [row],
        [row.id, row.id],
        [row.id]
      );

      expect(storedRecords).toHaveLength(1);
      expect(actual).toEqual(expected);
      expect(actual.map((w) => w.index)).toEqual([0, 1]);
    } finally {
      await Promise.all([h.store.quit(), h.probe.quit().catch(() => {})]);
    }
  });

  // Losing the records while the id list survives is the shape an eviction leaves behind.
  containerTest("and refuses when a member id has no record", async ({ prisma, redisOptions }) => {
    const h = harness(prisma as never, redisOptions as never);
    try {
      const env = await setupAuthenticatedEnvironment(prisma as never, "PRODUCTION");
      const row = await seedWaitpoint(prisma as never, env, {
        id: generateWaitpointId("MANUAL"),
        output: '{"lost":true}',
      });

      const sources = await h.coordinator.readCompletionEnvelopes({
        runId: h.runId,
        waitpointIds: [row.id],
      });
      await h.store.append({
        entry: entryFor(h.runId, env),
        kind: "birth",
        isTerminal: false,
        cycle: {
          kind: "new",
          completedWaitpoints: [{ id: row.id, index: 0 }],
          records: buildCompletedWaitpointRecords(sources),
        },
      });

      const read = await h.store.getLatest(h.runId);
      // The records field alone is lost; the id list survives.
      await h.probe.hdel(`snap:{${h.runId}}:wp:${read!.cycle!.cycleSeq}`, "records");

      const failure = await h
        .resolve({
          runId: h.runId,
          pointer: read!.cycle!,
          order: read!.completedWaitpointIds?.order ?? [],
          distinctIds: read!.completedWaitpointIds?.distinctIds ?? [],
          records: [],
        })
        .catch((caught: unknown) => caught as UnresolvableWaitpointId);

      expect(failure).toBeInstanceOf(UnresolvableWaitpointId);
      expect(failure.waitpointId).toBe(row.id);
      expect(failure.reason).toBe("no-source");
    } finally {
      await Promise.all([h.store.quit(), h.probe.quit().catch(() => {})]);
    }
  });
});
