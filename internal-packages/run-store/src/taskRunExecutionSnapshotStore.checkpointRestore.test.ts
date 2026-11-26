// A redis-primary run holds NO TRES rows: its snapshot history — including the SUSPENDED snapshot
// that carries the checkpointId — lives ONLY in MemoryDB. This proves a checkpoint suspend + restore
// survives a PROCESS RESTART: after the process that wrote the SUSPENDED snapshot is gone, a FRESH
// store + decorator pointed at the SAME Redis reads the suspended head (with its checkpointId,
// reproduced from MemoryDB, no TRES fallback) and continues the resume transition from it. The
// checkpoint ROW itself stays Postgres-resident. Proven against REAL Postgres + REAL Redis
// (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient, type RedisClient, type RedisOptions } from "@internal/redis";
import { CheckpointId, generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { TaskRunCheckpointType, type PrismaClient } from "@trigger.dev/database";
import { PostgresRunStore } from "./PostgresRunStore.js";
import {
  RedisSnapshotStore,
  type CompletedWaitpointResolver,
  type PreparedPgUnit,
} from "./redisSnapshotStore.js";
import { residencyKey, snapshotKeys } from "./snapshotKeys.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
  SnapshotWriteUnavailableError,
} from "./taskRunExecutionSnapshotStore.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";
import type { SnapshotFixtureEnv } from "./testFixtures/snapshotIdFixture.js";
import type { SnapshotResidency, SnapshotRouteWire } from "./snapshotResidency.js";
import type { StateHeldCheckpointInput } from "./types.js";
import { callsBetween, commandCalls } from "./testFixtures/redisCommandStats.js";

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

// Birth, then a SUSPENDED and a QUEUED snapshot that both refer to one checkpoint. `stateHeld`
// writes it into the run's snapshot state; `record` is set on both snapshots ("state" by default
// with `stateHeld`).
async function seedSuspendedThenQueued(
  prisma: PrismaClient,
  delegate: PostgresRunStore,
  store: RedisSnapshotStore,
  options?: { stateHeld?: Partial<StateHeldCheckpointInput>; record?: string }
) {
  const env = await seedSnapshotEnvironment(prisma);
  const runId = generateInternalId();
  const birthId = generateInternalId();
  const suspendedId = generateInternalId();
  const queuedId = generateInternalId();
  const base = Date.now();
  const birthAt = new Date(base);
  let checkpoint = options?.stateHeld ? undefined : await createCheckpoint(delegate, runId, env);
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
  if (options?.stateHeld) {
    checkpoint = await writer.createStateHeldCheckpoint(
      checkpointInput(env, options.stateHeld),
      runId,
      routeFor(env)
    );
  }
  if (!checkpoint) throw new Error("no checkpoint seeded");
  const record = options?.record ?? (options?.stateHeld ? "state" : undefined);
  const common = {
    run: { id: runId, status: "WAITING_TO_RESUME" as const, attemptNumber: 1 },
    checkpointId: checkpoint.id,
    ...(record !== undefined && { checkpointStore: record as "state" }),
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

// The route a queue message carries for a redis-primary run.
function routeFor(env: SnapshotFixtureEnv, residency: SnapshotResidency = "redis-primary") {
  return { version: 1, residency, organizationId: env.organizationId } satisfies SnapshotRouteWire;
}

function checkpointInput(
  env: SnapshotFixtureEnv,
  over: Partial<StateHeldCheckpointInput> = {}
): StateHeldCheckpointInput {
  return {
    ...CheckpointId.generate(),
    type: "COMPUTE",
    location: "s3://bucket/state-held",
    projectId: env.projectId,
    runtimeEnvironmentId: env.id,
    ...over,
  };
}

// Records every method read off the delegate. `PostgresRunStore` uses `#` members, so a method must
// be bound to the real target.
function recordingDelegate(target: PostgresRunStore) {
  const calls: string[] = [];
  const proxy = new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      calls.push(String(prop));
      return value.bind(t);
    },
  });
  return { proxy, calls };
}

async function setup(prisma: PrismaClient, redisOptions: RedisOptions, completedTtlMs = 60_000) {
  const postgres = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const recorder = recordingDelegate(postgres);
  const store = new RedisSnapshotStore({ redisOptions, completedTtlMs });
  const raw = createRedisClient(redisOptions, { onError: () => {} });
  const env = await seedSnapshotEnvironment(prisma);
  const decorate = (s: RedisSnapshotStore) =>
    new TaskRunExecutionSnapshotStore(recorder.proxy, {
      store: s,
      mode: "redis-only",
      resolveDial: () => "redis-only",
      logicalRunStoreRoute: ROUTE,
      resolveCompletedWaitpoints: resolver,
    });
  const decorator = decorate(store);
  const born = async () => {
    const runId = generateInternalId();
    const birthId = generateInternalId();
    await decorator.createRun({
      data: buildCreateRunData(runId, env),
      snapshot: birthSnapshot(env, birthId),
    });
    return { runId, birthId, k: snapshotKeys(runId) };
  };
  const snapshot = (
    runId: string,
    previousSnapshotId: string,
    executionStatus: "SUSPENDED" | "FINISHED",
    over: { checkpointId?: string; checkpointStore?: "state" } = {}
  ) => {
    const id = generateInternalId();
    return decorator
      .createExecutionSnapshot({
        id,
        createdAt: new Date(),
        run: {
          id: runId,
          status: executionStatus === "FINISHED" ? "COMPLETED_SUCCESSFULLY" : "EXECUTING",
          attemptNumber: 1,
        },
        snapshot: { executionStatus, description: executionStatus },
        previousSnapshotId,
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
        ...over,
      })
      .then(() => id);
  };
  const cleanup = async () => {
    await raw.quit();
    await store.quit();
  };
  return { postgres, recorder, store, raw, env, decorate, decorator, born, snapshot, cleanup };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

async function keysOf(raw: RedisClient, runId: string) {
  return (await raw.keys(`*${runId}*`)).sort();
}

describe("TaskRunExecutionSnapshotStore state-held checkpoint write", () => {
  // Catches: a stored row that differs from the Postgres row shape, or a stored form the snapshot-state read cannot parse.
  containerTest(
    "writes the checkpoint row into the run's :e hash and returns it",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      try {
        const { runId, k } = await t.born();
        const input = checkpointInput(t.env);
        const row = await t.decorator.createStateHeldCheckpoint(input, runId, routeFor(t.env));
        const pgRow = await t.postgres.createTaskRunCheckpoint({ data: input }, runId);

        expect(Object.keys(row).sort()).toEqual(Object.keys(pgRow).sort());
        expect(row.id).toBe(input.id);
        expect(row.friendlyId).toBe(input.friendlyId);
        for (const key of ["type", "location", "projectId", "runtimeEnvironmentId"] as const) {
          expect(row[key]).toBe(pgRow[key]);
        }
        expect(row.createdAt).toBeInstanceOf(Date);
        expect(row.updatedAt).toBe(row.createdAt);
        expect(row.imageRef).toBeNull();
        expect(row.reason).toBeNull();
        expect(row.metadata).toBeNull();
        const stored = await t.raw.hget(k.e, `${input.id}#cp`);
        expect(JSON.parse(stored!)).toEqual(JSON.parse(JSON.stringify(row)));
        expect(Object.keys(JSON.parse(stored!))).toEqual([
          "id",
          "friendlyId",
          "type",
          "location",
          "imageRef",
          "reason",
          "metadata",
          "projectId",
          "runtimeEnvironmentId",
          "createdAt",
          "updatedAt",
        ]);

        const big = "x".repeat(65_536);
        const metadata = `{"digest":"sha256:${"ab".repeat(32)}"}`;
        const input2 = checkpointInput(t.env, {
          type: "KUBERNETES",
          imageRef: big,
          reason: big,
          metadata,
        });
        const row2 = await t.decorator.createStateHeldCheckpoint(input2, runId, routeFor(t.env));
        expect([row2.type, row2.imageRef, row2.reason, row2.metadata]).toEqual([
          "KUBERNETES",
          big,
          big,
          metadata,
        ]);
        const stored2 = JSON.parse((await t.raw.hget(k.e, `${input2.id}#cp`))!);
        expect([stored2.type, stored2.imageRef, stored2.reason, stored2.metadata]).toEqual([
          "KUBERNETES",
          big,
          big,
          metadata,
        ]);

        // Every checkpoint type is kept as given, on the returned and the stored row.
        const types = Object.values(TaskRunCheckpointType);
        expect(types).toEqual(expect.arrayContaining(["DOCKER", "KUBERNETES", "COMPUTE"]));
        for (const type of types) {
          const typed = checkpointInput(t.env, { type });
          const typedRow = await t.decorator.createStateHeldCheckpoint(
            typed,
            runId,
            routeFor(t.env)
          );
          const typedStored = JSON.parse((await t.raw.hget(k.e, `${typed.id}#cp`))!);
          expect([typedRow.type, typedStored.type]).toEqual([type, type]);
        }
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: the write touching other keys, running more than one command, or reaching Postgres.
  containerTest(
    "is one MemoryDB command on the run's own :e, with no SQL",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      try {
        const warm = await t.born();
        await t.decorator.createStateHeldCheckpoint(
          checkpointInput(t.env),
          warm.runId,
          routeFor(t.env)
        );
        const { runId, k } = await t.born();
        const big = "y".repeat(65_536);
        for (const input of [
          checkpointInput(t.env),
          checkpointInput(t.env, { imageRef: big, reason: big }),
        ]) {
          const state = async () => ({
            keys: (await t.raw.keys("*")).sort(),
            hlen: await t.raw.hlen(k.e),
            idx: await t.raw.zrange(k.idx, 0, -1),
            cur: await t.raw.get(k.cur),
            seq: await t.raw.hgetall(k.seq),
            res: await t.raw.get(residencyKey(runId)),
          });
          const before = await state();
          const callsBefore = t.recorder.calls.length;
          const statsBefore = await commandCalls(t.raw);
          await t.decorator.createStateHeldCheckpoint(input, runId, routeFor(t.env));
          const statsAfter = await commandCalls(t.raw);
          const callsAfter = t.recorder.calls.length;
          const after = await state();

          const rose = Object.keys(statsAfter).filter(
            (c) => callsBetween(statsBefore, statsAfter, c) > 0
          );
          expect(
            callsBetween(statsBefore, statsAfter, "evalsha") +
              callsBetween(statsBefore, statsAfter, "eval")
          ).toBe(1);
          expect(callsBetween(statsBefore, statsAfter, "info")).toBe(1);
          expect(callsBetween(statsBefore, statsAfter, "exists")).toBeLessThanOrEqual(2);
          expect(callsBetween(statsBefore, statsAfter, "hset")).toBe(1);
          expect(
            rose.filter((c) => !["evalsha", "eval", "info", "exists", "hset"].includes(c))
          ).toEqual([]);

          expect(after.keys).toEqual(before.keys);
          expect(after.hlen).toBe(before.hlen + 1);
          expect({ ...after, hlen: 0 }).toEqual({ ...before, hlen: 0 });
          expect(callsAfter).toBe(callsBefore);
          expect(await prisma.taskRunCheckpoint.count({ where: { id: input.id } })).toBe(0);
        }
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: a run that is not MemoryDB-only getting a state-held checkpoint.
  containerTest(
    "the Postgres store refuses, and so does the decorator for a route that is not redis-primary",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      try {
        const { runId, k } = await t.born();
        const input = checkpointInput(t.env);
        const refused = await rejectionOf(
          t.postgres.createStateHeldCheckpoint(input, runId, routeFor(t.env))
        );
        expect(refused).toBeInstanceOf(Error);
        expect(refused).not.toBeInstanceOf(SnapshotWriteUnavailableError);
        expect(await prisma.taskRunCheckpoint.count({ where: { id: input.id } })).toBe(0);

        const hlen = await t.raw.hlen(k.e);
        for (const residency of ["postgres", "mirrored"] as const) {
          const error = await rejectionOf(
            t.decorator.createStateHeldCheckpoint(input, runId, routeFor(t.env, residency))
          );
          expect(error.constructor).toBe(refused.constructor);
          expect(error.message).toBe(refused.message);
          expect(await t.raw.hexists(k.e, `${input.id}#cp`)).toBe(0);
          expect(await t.raw.hlen(k.e)).toBe(hlen);
        }
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: the write creating a run's :e anew, without its expiry, or writing into a half-gone run state.
  containerTest(
    "rejects with no key created when the run has no snapshot state",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      try {
        const dropped = await t.born();
        await t.store.dropRun(dropped.runId);
        for (const runId of [generateInternalId(), dropped.runId]) {
          const k = snapshotKeys(runId);
          const error = await rejectionOf(
            t.decorator.createStateHeldCheckpoint(checkpointInput(t.env), runId, routeFor(t.env))
          );
          expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
          expect((error as SnapshotWriteUnavailableError).runId).toBe(runId);
          expect(await t.raw.exists(k.e)).toBe(0);
          expect(await t.raw.exists(k.seq)).toBe(0);
        }

        // Half a keyspace is not alive either: first :e without :seq.
        const half = await t.born();
        await t.raw.del(half.k.seq);
        const hlen = await t.raw.hlen(half.k.e);
        const error = await rejectionOf(
          t.decorator.createStateHeldCheckpoint(checkpointInput(t.env), half.runId, routeFor(t.env))
        );
        expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect(await t.raw.hlen(half.k.e)).toBe(hlen);
        expect(await t.raw.exists(half.k.seq)).toBe(0);

        // Then :seq without :e: the write must not create :e, so no key is added.
        const noE = await t.born();
        await t.raw.del(noE.k.e);
        const keysBefore = await keysOf(t.raw, noE.runId);
        const noEError = await rejectionOf(
          t.decorator.createStateHeldCheckpoint(checkpointInput(t.env), noE.runId, routeFor(t.env))
        );
        expect(noEError).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect(await t.raw.exists(noE.k.e)).toBe(0);
        expect(await keysOf(t.raw, noE.runId)).toEqual(keysBefore);
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: a MemoryDB failure swallowed, or answered from Postgres.
  containerTest(
    "throws the snapshot store's write error on a MemoryDB failure",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const closed = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const { runId, k } = await t.born();
        await closed.quit();
        const broken = t.decorate(closed);
        const input = checkpointInput(t.env);
        const callsBefore = t.recorder.calls.length;
        const error = await rejectionOf(
          broken.createStateHeldCheckpoint(input, runId, routeFor(t.env))
        );
        expect(t.recorder.calls.length).toBe(callsBefore);
        expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect((error as SnapshotWriteUnavailableError).runId).toBe(runId);
        expect(((error as SnapshotWriteUnavailableError).cause as Error).message).toBe(
          "Connection is closed."
        );
        expect(await prisma.taskRunCheckpoint.count({ where: { id: input.id } })).toBe(0);
        expect(await t.raw.hexists(k.e, `${input.id}#cp`)).toBe(0);
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: a store-level retry of a write that may have applied, here one that timed out in flight.
  containerTest(
    "does not replay a write that times out in flight, which still applies after the caller's error",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const client = createRedisClient(
        { ...redisOptions, commandTimeout: 200 },
        { onError: () => {} }
      );
      try {
        const { runId, k } = await t.born();
        const timing = t.decorate(new RedisSnapshotStore({ client, completedTtlMs: 60_000 }));
        // Load the script first, so the paused command is the EVALSHA itself.
        await timing.createStateHeldCheckpoint(checkpointInput(t.env), runId, routeFor(t.env));

        const input = checkpointInput(t.env);
        const before = await commandCalls(t.raw);
        // The pause outlasts any slow worker; the test ends it once it has seen the write held.
        await t.raw.call("CLIENT", "PAUSE", "30000", "WRITE");
        const error = await rejectionOf(
          timing.createStateHeldCheckpoint(input, runId, routeFor(t.env))
        );
        expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect(((error as SnapshotWriteUnavailableError).cause as Error).message).toContain(
          "Command timed out"
        );
        expect(await t.raw.hexists(k.e, `${input.id}#cp`)).toBe(0);
        await t.raw.call("CLIENT", "UNPAUSE");

        // The server runs the paused write once the pause ends: the orphan the write accepts.
        const deadline = Date.now() + 5_000;
        while ((await t.raw.hexists(k.e, `${input.id}#cp`)) === 0) {
          expect(Date.now()).toBeLessThan(deadline);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const after = await commandCalls(t.raw);
        const sent = callsBetween(before, after, "evalsha") + callsBetween(before, after, "eval");
        expect(sent).toBe(1);
      } finally {
        await t.raw.call("CLIENT", "UNPAUSE").catch(() => undefined);
        await client.quit();
        await t.cleanup();
      }
    }
  );

  // Catches: an entry or a read dropping the state-held record beside its checkpointId.
  containerTest(
    "a snapshot entry carries the state-held record and the reads return it",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      try {
        const { runId, birthId } = await t.born();
        const input = checkpointInput(t.env);
        await t.decorator.createStateHeldCheckpoint(input, runId, routeFor(t.env));
        const suspendedId = await t.snapshot(runId, birthId, "SUSPENDED", {
          checkpointId: input.id,
          checkpointStore: "state",
        });

        const latest = await t.store.getLatest(runId);
        expect(latest?.raw).toContain('"checkpointStore":"state"');
        const since = await t.store.getSinceCreatedAt(runId, new Date(0));
        const sinceEntry =
          since.kind === "hit" ? since.entries.find((e) => e.id === suspendedId) : undefined;
        for (const read of [latest, await t.store.getById(runId, suspendedId), sinceEntry]) {
          expect(read?.entry.checkpointStore).toBe("state");
          expect(read?.entry.checkpointId).toBe(input.id);
        }

        for (const read of [
          await t.decorator.findLatestExecutionSnapshot(runId),
          await t.decorator.findExecutionSnapshot(
            { where: { runId, id: suspendedId } },
            undefined,
            routeFor(t.env)
          ),
        ]) {
          expect(read?.checkpointStore).toBe("state");
          expect(read?.checkpointId).toBe(input.id);
        }
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: an entry without the record, or with any value but "state", read as anything but a Postgres checkpoint.
  containerTest(
    "an entry without the record reads its Postgres checkpoint as today",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      try {
        const { runId, birthId } = await t.born();
        const checkpoint = await createCheckpoint(t.postgres, runId, t.env);
        const suspendedId = await t.snapshot(runId, birthId, "SUSPENDED", {
          checkpointId: checkpoint.id,
        });

        expect((await t.store.getLatest(runId))?.raw).not.toContain("checkpointStore");
        for (const read of [
          await t.decorator.findLatestExecutionSnapshot(runId),
          await t.decorator.findExecutionSnapshot(
            { where: { runId, id: suspendedId } },
            undefined,
            routeFor(t.env)
          ),
        ]) {
          expect("checkpointStore" in read!).toBe(false);
          expect(read?.checkpoint?.id).toBe(checkpoint.id);
          expect(read?.checkpoint?.location).toBe("s3://bucket/checkpoint");
        }

        // A value other than "state" (no build writes one) is not a state-held record.
        const otherId = await t.snapshot(runId, suspendedId, "SUSPENDED", {
          checkpointId: checkpoint.id,
          checkpointStore: "postgres" as unknown as "state",
        });
        expect((await t.store.getLatest(runId))?.raw).toContain('"checkpointStore":"postgres"');
        for (const read of [
          await t.decorator.findLatestExecutionSnapshot(runId),
          await t.decorator.findExecutionSnapshot(
            { where: { runId, id: otherId } },
            undefined,
            routeFor(t.env)
          ),
        ]) {
          expect("checkpointStore" in read!).toBe(false);
          expect(read?.checkpoint?.id).toBe(checkpoint.id);
        }
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: a state-held checkpoint outliving its run's snapshot state after the run ends.
  containerTest(
    "expires with the run state after a terminal entry",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions, 3_000);
      try {
        const { runId, birthId, k } = await t.born();
        for (let i = 0; i < 2; i++) {
          await t.decorator.createStateHeldCheckpoint(
            checkpointInput(t.env),
            runId,
            routeFor(t.env)
          );
        }
        await t.snapshot(runId, birthId, "FINISHED");
        const deadline = Date.now() + 8_000;
        await t.decorator.createStateHeldCheckpoint(checkpointInput(t.env), runId, routeFor(t.env));
        const pttl = await t.raw.pttl(k.e);
        expect(pttl).toBeGreaterThan(0);
        expect(pttl).toBeLessThanOrEqual(3_000);

        while ((await t.raw.exists(k.e)) === 1) {
          expect(Date.now()).toBeLessThan(deadline);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(await keysOf(t.raw, runId)).toEqual([residencyKey(runId)]);
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: a state-held checkpoint kept outside :e, so removing the run leaves it behind.
  containerTest("is removed with the run state", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    try {
      const { runId, k } = await t.born();
      await t.decorator.createStateHeldCheckpoint(checkpointInput(t.env), runId, routeFor(t.env));
      await t.store.dropRun(runId);
      expect(await t.raw.exists(k.e)).toBe(0);
      expect(await keysOf(t.raw, runId)).toEqual([residencyKey(runId)]);
    } finally {
      await t.cleanup();
    }
  });
});

// Records the checkpoint id of each state-held checkpoint read; every other command reaches MemoryDB.
class CountingCheckpointStateStore extends RedisSnapshotStore {
  readonly reads: string[] = [];

  override async readCheckpoint(runId: string, checkpointId: string): Promise<string | null> {
    this.reads.push(checkpointId);
    return super.readCheckpoint(runId, checkpointId);
  }
}

// A store whose state-held checkpoint read fails, as a MemoryDB error would.
class FailingCheckpointStateStore extends RedisSnapshotStore {
  readonly failure = new Error("checkpoint state read failed");

  override async readCheckpoint(): Promise<never> {
    throw this.failure;
  }
}

function checkpointLookups(calls: string[]) {
  return calls.filter((c) => c === "findTaskRunCheckpointById").length;
}

describe("TaskRunExecutionSnapshotStore (redis-only) state-held checkpoint reads", () => {
  function readerOver(delegate: PostgresRunStore, store: RedisSnapshotStore) {
    const recorder = recordingDelegate(delegate);
    const reader = new TaskRunExecutionSnapshotStore(recorder.proxy, {
      store,
      mode: "redis-only",
      logicalRunStoreRoute: ROUTE,
      resolveCompletedWaitpoints: resolver,
    });
    return { reader, calls: recorder.calls };
  }

  // Catches: a state-held checkpoint read back with string dates, other keys, or changed values.
  containerTest(
    "the latest, by-id and since reads return the state-held checkpoint as the row it was written",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new CountingCheckpointStateStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const seeded = await seedSuspendedThenQueued(prisma, delegate, store, { stateHeld: {} });
        const { reader } = readerOver(delegate, store);
        const [readLatest, readById, readWindow] = readAll(
          reader,
          seeded.runId,
          seeded.suspendedId,
          seeded.birthAt
        );
        const latest = await readLatest();
        const byId = (await readById()) as Awaited<ReturnType<typeof readLatest>>;
        const window = await readWindow();

        expect(window.map((row) => row.id)).toEqual([seeded.queuedId, seeded.suspendedId]);
        for (const checkpoint of [
          latest?.checkpoint,
          byId?.checkpoint,
          ...window.map((row) => row.checkpoint),
        ]) {
          expect(checkpoint).toEqual(seeded.checkpoint);
          expect(checkpoint?.createdAt).toBeInstanceOf(Date);
          expect(checkpoint?.updatedAt).toBeInstanceOf(Date);
        }
        expect(latest?.checkpointStore).toBe("state");
        expect(byId?.checkpointStore).toBe("state");
        for (const row of window) {
          expect("checkpointStore" in row).toBe(false);
        }
        const pgRow = await createCheckpoint(delegate, seeded.runId, seeded.env);
        expect(Object.keys(latest!.checkpoint!).sort()).toEqual(Object.keys(pgRow).sort());

        const big = "x".repeat(65_536);
        const metadata = `{"digest":"sha256:${"cd".repeat(32)}"}`;
        const large = await seedSuspendedThenQueued(prisma, delegate, store, {
          stateHeld: { type: "KUBERNETES", imageRef: big, reason: big, metadata },
        });
        const [largeLatest, largeById, largeWindow] = readAll(
          reader,
          large.runId,
          large.suspendedId,
          large.birthAt
        );
        const largeRows = [
          (await largeLatest())?.checkpoint,
          ((await largeById()) as Awaited<ReturnType<typeof largeLatest>>)?.checkpoint,
          ...(await largeWindow()).map((row) => row.checkpoint),
        ];
        expect(largeRows).toHaveLength(4);
        for (const checkpoint of largeRows) {
          expect([
            checkpoint?.type,
            checkpoint?.imageRef,
            checkpoint?.reason,
            checkpoint?.metadata,
          ]).toEqual(["KUBERNETES", big, big, metadata]);
        }
      } finally {
        await store.quit();
      }
    }
  );

  // Catches: a state-held checkpoint also read from Postgres, or read more than once per snapshot.
  containerTest(
    "reads one state-held checkpoint per snapshot and none from Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new CountingCheckpointStateStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const seeded = await seedSuspendedThenQueued(prisma, delegate, store, { stateHeld: {} });
        const { reader, calls } = readerOver(delegate, store);
        const id = seeded.checkpoint.id;
        const expected = [[id], [id, id], [id, id, id, id]];
        const reads = readAll(reader, seeded.runId, seeded.suspendedId, seeded.birthAt);
        for (let i = 0; i < reads.length; i++) {
          await reads[i]();
          expect(checkpointLookups(calls)).toBe(0);
          expect(store.reads).toEqual(expected[i]);
        }
      } finally {
        await store.quit();
      }
    }
  );

  // Catches: an entry with no record, or a record other than "state", not read from Postgres as today.
  containerTest(
    "an entry with no record, or a record other than state, reads its checkpoint from Postgres",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new CountingCheckpointStateStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        for (const options of [undefined, { record: "postgres" }, { record: "State" }]) {
          const seeded = await seedSuspendedThenQueued(prisma, delegate, store, options);
          const { reader, calls } = readerOver(delegate, store);
          const [readLatest, readById, readWindow] = readAll(
            reader,
            seeded.runId,
            seeded.suspendedId,
            seeded.birthAt
          );
          const latest = await readLatest();
          expect(checkpointLookups(calls)).toBe(1);
          const byId = (await readById()) as Awaited<ReturnType<typeof readLatest>>;
          expect(checkpointLookups(calls)).toBe(2);
          const window = await readWindow();
          expect(checkpointLookups(calls)).toBe(4);

          const checkpoints = [
            latest?.checkpoint,
            byId?.checkpoint,
            ...window.map((r) => r.checkpoint),
          ];
          expect(checkpoints).toHaveLength(4);
          for (const checkpoint of checkpoints) {
            expect(checkpoint?.id).toBe(seeded.checkpoint.id);
            expect(checkpoint?.location).toBe("s3://bucket/checkpoint");
          }
          expect(store.reads).toEqual([]);
        }
      } finally {
        await store.quit();
      }
    }
  );

  // Catches: a failed state-held checkpoint read swallowed, unwrapped, or followed by a Postgres read.
  containerTest(
    "a failing state-held checkpoint read rejects the latest, by-id and since reads as read-unavailable",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new FailingCheckpointStateStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const seeded = await seedSuspendedThenQueued(prisma, delegate, store, { stateHeld: {} });
        const { reader, calls } = readerOver(delegate, store);
        for (const read of readAll(reader, seeded.runId, seeded.suspendedId, seeded.birthAt)) {
          const error = await rejectionOf(read());
          expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
          expect(error).toMatchObject({
            runId: seeded.runId,
            reason: "readCheckpoint failed",
            retriable: true,
          });
          expect((error as SnapshotReadUnavailableError).cause).toBe(store.failure);
        }
        expect(checkpointLookups(calls)).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  // Catches: a stored checkpoint that is not JSON parsed outside the wrapped read, or read from Postgres.
  containerTest(
    "a state-held checkpoint stored as a value that is not JSON rejects the reads as read-unavailable",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new CountingCheckpointStateStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const seeded = await seedSuspendedThenQueued(prisma, delegate, store, { stateHeld: {} });
        await raw.hset(snapshotKeys(seeded.runId).e, `${seeded.checkpoint.id}#cp`, "{not json");
        const { reader, calls } = readerOver(delegate, store);
        for (const read of readAll(reader, seeded.runId, seeded.suspendedId, seeded.birthAt)) {
          const error = await rejectionOf(read());
          expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
          expect(error).toMatchObject({ runId: seeded.runId, reason: "readCheckpoint failed" });
        }
        expect(checkpointLookups(calls)).toBe(0);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  // Catches: a state-held checkpoint missing from the state read as an error, dropped id, or from Postgres.
  containerTest(
    "a state-held checkpoint missing from the state reads as no checkpoint, with the id kept",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new CountingCheckpointStateStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const seeded = await seedSuspendedThenQueued(prisma, delegate, store, { stateHeld: {} });
        const id = seeded.checkpoint.id;
        expect(await raw.hdel(snapshotKeys(seeded.runId).e, `${id}#cp`)).toBe(1);
        const { reader, calls } = readerOver(delegate, store);
        const [readLatest, readById, readWindow] = readAll(
          reader,
          seeded.runId,
          seeded.suspendedId,
          seeded.birthAt
        );

        const latest = await readWithoutError(readLatest);
        expect([latest?.id, latest?.checkpointId, latest?.checkpoint]).toEqual([
          seeded.queuedId,
          id,
          null,
        ]);
        expect(store.reads).toEqual([id]);
        const byId = (await readWithoutError(readById)) as Awaited<ReturnType<typeof readLatest>>;
        expect([byId?.id, byId?.checkpointId, byId?.checkpoint]).toEqual([
          seeded.suspendedId,
          id,
          null,
        ]);
        expect(store.reads).toEqual([id, id]);
        const window = await readWithoutError(readWindow);
        expect(window.map((s) => [s.id, s.checkpointId, s.checkpoint])).toEqual([
          [seeded.queuedId, id, null],
          [seeded.suspendedId, id, null],
        ]);
        expect(store.reads).toEqual([id, id, id, id]);
        expect(checkpointLookups(calls)).toBe(0);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  // Catches: a snapshot reading another snapshot's checkpoint, or a run's two checkpoint stores mixed up.
  containerTest(
    "each snapshot reads its own checkpoint from the store its record names",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const counting = new CountingCheckpointStateStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const { runId, birthId } = await t.born();
        const c0 = await createCheckpoint(t.postgres, runId, t.env);
        const s0 = await t.snapshot(runId, birthId, "SUSPENDED", { checkpointId: c0.id });
        const state = { checkpointStore: "state" as const };
        const c1 = await t.decorator.createStateHeldCheckpoint(
          checkpointInput(t.env),
          runId,
          routeFor(t.env)
        );
        const s1 = await t.snapshot(runId, s0, "SUSPENDED", { checkpointId: c1.id, ...state });
        const s2 = await t.snapshot(runId, s1, "SUSPENDED", { checkpointId: c1.id, ...state });
        const c2 = await t.decorator.createStateHeldCheckpoint(
          checkpointInput(t.env),
          runId,
          routeFor(t.env)
        );
        const s3 = await t.snapshot(runId, s2, "SUSPENDED", { checkpointId: c2.id, ...state });
        const s4 = await t.snapshot(runId, s3, "SUSPENDED", { checkpointId: c2.id, ...state });
        const reader = t.decorate(counting);

        const lookupsBefore = checkpointLookups(t.recorder.calls);
        const window = await reader.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: new Date(0) } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
        expect(Object.fromEntries(window.map((row) => [row.id, row.checkpoint?.id]))).toEqual({
          [birthId]: undefined,
          [s0]: c0.id,
          [s1]: c1.id,
          [s2]: c1.id,
          [s3]: c2.id,
          [s4]: c2.id,
        });
        expect(checkpointLookups(t.recorder.calls) - lookupsBefore).toBe(1);
        expect([...counting.reads].sort()).toEqual([c2.id, c2.id, c1.id, c1.id].sort());

        expect((await reader.findLatestExecutionSnapshot(runId))?.checkpoint?.id).toBe(c2.id);
        const byId = await reader.findExecutionSnapshot(
          { where: { runId, id: s1 } },
          undefined,
          routeFor(t.env)
        );
        expect((byId as { checkpoint?: { id: string } | null } | null)?.checkpoint?.id).toBe(c1.id);
      } finally {
        await counting.quit();
        await t.cleanup();
      }
    }
  );
});
