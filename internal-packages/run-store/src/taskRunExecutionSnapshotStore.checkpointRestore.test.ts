// A redis-primary run holds NO TRES rows: its snapshot history — including the SUSPENDED snapshot
// that carries the checkpointId — lives ONLY in MemoryDB. This proves a checkpoint suspend + restore
// survives a PROCESS RESTART: after the process that wrote the SUSPENDED snapshot is gone, a FRESH
// store + decorator pointed at the SAME Redis reads the suspended head (with its checkpointId,
// reproduced from MemoryDB, no TRES fallback) and continues the resume transition from it. The
// checkpoint ROW itself stays Postgres-resident. Proven against REAL Postgres + REAL Redis
// (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, type CompletedWaitpointResolver } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
} from "./taskRunExecutionSnapshotStore.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

// A no-op resolver: these snapshots carry no completed-waitpoint cycle, so the resolver is never
// asked to expand records. It only needs to exist for the read surface to accept a redis-primary read.
const resolver: CompletedWaitpointResolver = async ({ records }) =>
  records.map((r) => ({
    id: r.id,
    friendlyId: r.friendlyId,
    type: r.type,
    completedAt: new Date(r.completedAt),
    completedByTaskRunId: r.completedByTaskRunId ?? null,
    completedByBatchId: r.completedByBatchId ?? null,
    completedAfter: r.completedAfter ? new Date(r.completedAfter) : null,
    outputType: r.outputType,
    outputIsError: r.outputIsError,
    output: r.output && "inline" in r.output ? r.output.inline : null,
    idempotencyKey: r.idempotencyKey ?? "",
    userProvidedIdempotencyKey: r.idempotencyKey !== undefined,
    inactiveIdempotencyKey: null,
  }));

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

async function createCheckpoint(
  delegate: PostgresRunStore,
  runId: string,
  env: { projectId: string; id: string }
) {
  return delegate.createTaskRunCheckpoint(
    {
      data: {
        friendlyId: `checkpoint_${generateInternalId().slice(-12)}`,
        type: "DOCKER",
        location: "s3://bucket/checkpoint",
        projectId: env.projectId,
        runtimeEnvironmentId: env.id,
      },
    },
    runId
  );
}

describe("TaskRunExecutionSnapshotStore (redis-only) checkpoint restore across restart", () => {
  containerTest(
    "a suspended snapshot + its checkpointId survive a process restart and the resume continues",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      // The FIRST process: births the run and suspends it with a checkpoint, then is dropped entirely.
      const store1 = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const birthId = generateInternalId();
      const executingId = generateInternalId();
      const suspendedId = generateInternalId();

      const checkpoint = await createCheckpoint(delegate, runId, env);

      try {
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store: store1,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
        });

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot({
          id: executingId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Run started" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });
        await writer.createExecutionSnapshot({
          id: suspendedId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "SUSPENDED", description: "Suspended for checkpoint" },
          previousSnapshotId: executingId,
          checkpointId: checkpoint.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        // Redis-primary: Postgres holds NO snapshot row; MemoryDB's head IS the suspended snapshot and
        // its entry carries the checkpointId. The checkpoint ROW is the Postgres-resident one.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        const head1 = await store1.getLatest(runId);
        expect(head1?.id).toBe(suspendedId);
        const entry1 = head1?.entry as
          | { executionStatus?: string; checkpointId?: string }
          | undefined;
        expect(entry1?.executionStatus).toBe("SUSPENDED");
        expect(entry1?.checkpointId).toBe(checkpoint.id);
      } finally {
        // The process is gone: this store instance and its in-memory state no longer exist.
        await store1.quit();
      }

      // RESTART: a BRAND NEW store + decorator over the SAME redisOptions (same keyspace) and the same
      // Postgres, with cold in-memory state — a fresh process reattaching to the durable MemoryDB.
      const store2 = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store: store2,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });

        // RESTORE: the suspended head is reproduced from MemoryDB alone (no TRES row exists), carrying
        // its checkpointId, and the checkpoint hydrates from the Postgres row by id.
        const restored = await reader.findLatestExecutionSnapshot(runId);
        expect(restored?.id).toBe(suspendedId);
        expect(restored?.executionStatus).toBe("SUSPENDED");
        expect(restored?.previousSnapshotId).toBe(executingId);
        expect(restored?.checkpointId).toBe(checkpoint.id);
        expect(restored?.checkpoint?.id).toBe(checkpoint.id);
        expect(restored?.checkpoint?.location).toBe("s3://bucket/checkpoint");

        // The resume transition, written through the NEW decorator, chains off the durable suspended
        // head: the fork guard checks previousSnapshotId against the MemoryDB committed head, which
        // survived the restart. It succeeds and the head advances.
        const resumeId = generateInternalId();
        await reader.createExecutionSnapshot({
          id: resumeId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Resumed from checkpoint" },
          previousSnapshotId: suspendedId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        expect((await store2.getLatest(runId))?.id).toBe(resumeId);
        const resumed = await reader.findLatestExecutionSnapshot(runId);
        expect(resumed?.id).toBe(resumeId);
        expect(resumed?.executionStatus).toBe("EXECUTING");
        expect(resumed?.previousSnapshotId).toBe(suspendedId);

        // Still redis-primary throughout: Postgres holds NO TRES row, and the checkpoint row is the
        // same Postgres-resident one.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        expect(await prisma.taskRunCheckpoint.count({ where: { id: checkpoint.id } })).toBe(1);
      } finally {
        await store2.quit();
      }
    }
  );

  containerTest(
    "a restart with the suspended state gone fails closed, never an empty-Postgres success",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store1 = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const birthId = generateInternalId();
      const suspendedId = generateInternalId();
      const checkpoint = await createCheckpoint(delegate, runId, env);

      try {
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store: store1,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot({
          id: suspendedId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "SUSPENDED", description: "Suspended for checkpoint" },
          previousSnapshotId: birthId,
          checkpointId: checkpoint.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });
      } finally {
        await store1.quit();
      }

      const store2 = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        // Model the suspended state being gone after the restart (as a 14-day TTL would drop it): the
        // no-TTL residency marker survives, so residency resolves to `expired`, never a Postgres miss.
        await store2.dropRun(runId);
        expect(await store2.getLatest(runId)).toBeNull();
        expect(await store2.readBirthResidency(runId)).toBe("redis-primary");

        // A Postgres snapshot row planted for the same run: a wrongful fallback would return it. The
        // redis-primary read must fail closed instead, never serving the empty-Postgres head.
        await prisma.taskRunExecutionSnapshot.create({
          data: {
            id: generateInternalId(),
            runId,
            engine: "V2",
            executionStatus: "EXECUTING",
            description: "planted",
            runStatus: "EXECUTING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store: store2,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });
        await expect(reader.findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
          SnapshotReadUnavailableError
        );
      } finally {
        await store2.quit();
      }
    }
  );
});
