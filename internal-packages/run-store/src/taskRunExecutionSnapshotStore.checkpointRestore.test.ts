// A redis-primary run holds NO TRES rows: its snapshot history — including the SUSPENDED snapshot
// that carries the checkpointId — lives ONLY in MemoryDB. This proves a checkpoint suspend + restore
// survives a PROCESS RESTART: after the process that wrote the SUSPENDED snapshot is gone, a FRESH
// store + decorator pointed at the SAME Redis reads the suspended head (with its checkpointId,
// reproduced from MemoryDB, no TRES fallback) and continues the resume transition from it. The
// checkpoint ROW itself stays Postgres-resident. Proven against REAL Postgres + REAL Redis
// (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { PostgresRunStore } from "./PostgresRunStore.js";
import {
  RedisSnapshotStore,
  type CompletedWaitpointResolver,
  type PreparedPgUnit,
} from "./redisSnapshotStore.js";
import { snapshotKeys } from "./snapshotKeys.js";
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

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

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

// A delegate whose checkpoint read fails, as a Postgres error would.
class FailingCheckpointReadStore extends PostgresRunStore {
  readonly failure = new Error("checkpoint read failed");

  override async findTaskRunCheckpointById(): Promise<never> {
    throw this.failure;
  }
}

// Birth, then a SUSPENDED and a QUEUED snapshot that both refer to one checkpoint.
async function seedSuspendedThenQueued(
  prisma: PrismaClient,
  delegate: PostgresRunStore,
  store: RedisSnapshotStore
) {
  const env = await seedSnapshotEnvironment(prisma);
  const runId = generateInternalId();
  const birthId = generateInternalId();
  const suspendedId = generateInternalId();
  const queuedId = generateInternalId();
  const base = Date.now();
  const birthAt = new Date(base);
  const checkpoint = await createCheckpoint(delegate, runId, env);
  const writer = new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "redis-only",
    resolveDial: () => "redis-only",
    logicalRunStoreRoute: ROUTE,
  });
  await writer.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: { ...birthSnapshot(env, birthId), createdAt: birthAt },
  });
  const common = {
    run: { id: runId, status: "WAITING_TO_RESUME" as const, attemptNumber: 1 },
    checkpointId: checkpoint.id,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
  await writer.createExecutionSnapshot({
    ...common,
    id: suspendedId,
    createdAt: new Date(base + 1),
    snapshot: {
      executionStatus: "SUSPENDED",
      description: "Run was suspended after creating a checkpoint.",
    },
    previousSnapshotId: birthId,
  });
  await writer.createExecutionSnapshot({
    ...common,
    id: queuedId,
    createdAt: new Date(base + 2),
    run: { id: runId, status: "PENDING" as const, attemptNumber: 1 },
    snapshot: {
      executionStatus: "QUEUED",
      description: "Run was QUEUED, because all waitpoints are completed",
    },
    previousSnapshotId: suspendedId,
  });
  expect(await store.readBirthResidency(runId)).toBe("redis-primary");
  expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
  return { env, runId, birthId, suspendedId, queuedId, birthAt, checkpoint };
}

// The three reads, each started only when called.
function readAll(
  reader: TaskRunExecutionSnapshotStore,
  runId: string,
  suspendedId: string,
  birthAt: Date
) {
  return [
    () => reader.findLatestExecutionSnapshot(runId),
    () => reader.findExecutionSnapshot({ where: { id: suspendedId, runId } }),
    () =>
      reader.findManyExecutionSnapshots({
        where: { runId, isValid: true, createdAt: { gt: birthAt } },
        include: { checkpoint: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
  ] as const;
}

// Runs a read and, if it rejects, fails as an assertion that names the error.
async function readWithoutError<T>(read: () => Promise<T>): Promise<T> {
  const outcome = await read().then(
    (value) => ({ rejected: false as const, value }),
    (error: unknown) => ({ rejected: true as const, error })
  );
  expect(outcome).toMatchObject({ rejected: false });
  if (outcome.rejected) throw outcome.error;
  return outcome.value;
}

describe("TaskRunExecutionSnapshotStore (redis-only) checkpoint reads and quarantine", () => {
  // Catches: a MemoryDB-only read that throws, or drops the checkpoint id, when the checkpoint row is gone.
  containerTest(
    "a missing checkpoint row reads as no checkpoint, with the id kept, in the latest, by-id and since reads",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const seeded = await seedSuspendedThenQueued(prisma, delegate, store);
        await prisma.taskRunCheckpoint.delete({ where: { id: seeded.checkpoint.id } });

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });
        const [readLatest, readById, readWindow] = readAll(
          reader,
          seeded.runId,
          seeded.suspendedId,
          seeded.birthAt
        );
        const latest = await readWithoutError(readLatest);
        const byId = await readWithoutError(readById);
        const window = await readWithoutError(readWindow);

        expect(latest?.id).toBe(seeded.queuedId);
        expect(latest?.executionStatus).toBe("QUEUED");
        expect(latest?.checkpointId).toBe(seeded.checkpoint.id);
        expect(latest?.checkpoint).toBeNull();
        expect(byId?.id).toBe(seeded.suspendedId);
        expect(byId?.executionStatus).toBe("SUSPENDED");
        expect(byId?.checkpointId).toBe(seeded.checkpoint.id);
        expect((byId as { checkpoint?: unknown } | null)?.checkpoint).toBeNull();
        expect(window.map((s) => [s.id, s.executionStatus, s.checkpointId, s.checkpoint])).toEqual([
          [seeded.queuedId, "QUEUED", seeded.checkpoint.id, null],
          [seeded.suspendedId, "SUSPENDED", seeded.checkpoint.id, null],
        ]);
      } finally {
        await store.quit();
      }
    }
  );

  // Catches: a failed checkpoint read wrapped in, or swallowed as, the snapshot store's own error.
  containerTest(
    "a failing checkpoint read rejects the latest, by-id and since reads with the delegate's own error",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const seeded = await seedSuspendedThenQueued(prisma, delegate, store);
        const failing = new FailingCheckpointReadStore({ prisma, readOnlyPrisma: prisma });
        const reader = new TaskRunExecutionSnapshotStore(failing, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });

        for (const read of readAll(reader, seeded.runId, seeded.suspendedId, seeded.birthAt)) {
          const error = await read().then(
            () => undefined,
            (e: unknown) => e
          );
          expect(error).toBe(failing.failure);
          expect(error).not.toBeInstanceOf(SnapshotReadUnavailableError);
        }
      } finally {
        await store.quit();
      }
    }
  );

  // Catches: a quarantine that gives a suspended run's state an expiry, or loses its checkpoint id,
  // and a later terminal write whose expiry is not the store's completed TTL.
  containerTest(
    "a quarantined run keeps its snapshot state with no expiry and its SUSPENDED entry keeps the checkpoint id",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const completedTtlMs = 60_000;
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const suspendedId = generateInternalId();
        const checkpoint = await createCheckpoint(delegate, runId, env);
        const options = {
          store,
          mode: "redis-only" as const,
          resolveDial: () => "redis-only" as const,
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        };
        const common = {
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        };
        const writer = new TaskRunExecutionSnapshotStore(delegate, options);
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot({
          ...common,
          id: suspendedId,
          createdAt: new Date(),
          run: { id: runId, status: "WAITING_TO_RESUME", attemptNumber: 1 },
          snapshot: { executionStatus: "SUSPENDED", description: "Suspended for checkpoint" },
          previousSnapshotId: birthId,
          checkpointId: checkpoint.id,
        });
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        // A crash after the Postgres commit leaves the next write prepared.
        const crash = new Error("crash before finalize");
        const crashing = new TaskRunExecutionSnapshotStore(delegate, {
          ...options,
          hooks: {
            beforeFinalize: () => {
              throw crash;
            },
          },
        });
        await expect(
          crashing.createExecutionSnapshot({
            ...common,
            id: generateInternalId(),
            createdAt: new Date(),
            run: { id: runId, status: "PENDING", attemptNumber: 1 },
            snapshot: { executionStatus: "QUEUED", description: "Resumed" },
            previousSnapshotId: suspendedId,
            checkpointId: checkpoint.id,
          })
        ).rejects.toBe(crash);

        const unitRaw = await store.readPreparedUnitRaw(runId);
        expect(unitRaw).toBeTypeOf("string");
        const unit = JSON.parse(unitRaw!) as PreparedPgUnit;
        expect(await store.quarantinePreparedUnit(unit, "redis-primary-null")).toEqual({
          moved: true,
        });

        const keys = snapshotKeys(runId);
        const pttls = async () =>
          Promise.all([keys.e, keys.idx, keys.cur, keys.seq].map((k) => raw.pttl(k)));
        expect(await store.readPendingState(runId)).toEqual({ prepared: false, quarantined: true });
        expect(await pttls()).toEqual([-1, -1, -1, -1]);

        const suspendedEntry = JSON.parse((await raw.hget(keys.e, suspendedId)) ?? "null");
        expect(suspendedEntry?.executionStatus).toBe("SUSPENDED");
        expect(suspendedEntry?.checkpointId).toBe(checkpoint.id);
        const head = await store.getLatest(runId);
        expect(head?.id).toBe(suspendedId);
        expect((head?.entry as { checkpointId?: string } | undefined)?.checkpointId).toBe(
          checkpoint.id
        );

        const fresh = () => new TaskRunExecutionSnapshotStore(delegate, options);
        await expect(fresh().findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
          SnapshotReadUnavailableError
        );

        // Recorded on base: a terminal write after the quarantine is accepted, and gives the four keys
        // the store's completed TTL, less at most the time the write and the reads took.
        const writeStartedAt = Date.now();
        const finished = await fresh()
          .createExecutionSnapshot({
            ...common,
            id: generateInternalId(),
            createdAt: new Date(),
            run: { id: runId, status: "CANCELED", attemptNumber: 1 },
            snapshot: { executionStatus: "FINISHED", description: "Run was cancelled" },
            previousSnapshotId: suspendedId,
          })
          .then(
            () => "accepted",
            (error: unknown) => (error as Error).name
          );
        const expiries = await pttls();
        const elapsedMs = Date.now() - writeStartedAt;
        expect(finished).toBe("accepted");
        for (const pttl of expiries) {
          expect(pttl).toBeLessThanOrEqual(completedTtlMs);
          expect(pttl).toBeGreaterThanOrEqual(completedTtlMs - elapsedMs - 1);
        }
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );
});
