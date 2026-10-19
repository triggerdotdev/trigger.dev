// The finalize after a Postgres commit can throw even though MemoryDB applied the unit (a client
// timeout during an event-loop stall). Postgres has committed and the head moved, so the transaction
// must not report a definitive failure for a transition that may have applied: it proves the staged
// entries are already applied, else retries the token-fenced finalize ONCE, and only then fails closed
// (retriable, unit left pending for the recovery worker). Real Postgres + real Redis; the injections
// are a wrapper around the store's own finalize and, where a test says so, a failing read command on
// the Redis client underneath the store.
import { createRedisClient, type RedisClient } from "@internal/redis";
import { describe, expect, vi } from "vitest";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotWriteUnavailableError,
  type SnapshotDecoratorMetrics,
} from "./taskRunExecutionSnapshotStore.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";
const TIMEOUT = "Command timed out";
// The production client's command timeout: a read against an unreachable MemoryDB costs this long.
const CLIENT_TIMEOUT_MS = 500;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function birthSnapshot(env: SnapshotFixtureEnv, id: string) {
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

function transitionInput(env: SnapshotFixtureEnv, runId: string, id: string, previous: string) {
  return {
    id,
    createdAt: new Date(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "started" },
    previousSnapshotId: previous,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

function recorder() {
  const writes: string[] = [];
  const metrics: SnapshotDecoratorMetrics = {
    recordWrite: (o) => writes.push(o),
    recordReadSource: () => undefined,
  };
  return { writes, metrics };
}

// How the wrapped finalize behaves on each call: `applyThenThrow` runs the real finalize then throws
// (the reply was lost), `throw` throws without applying, `timeout` throws without applying after the
// client's command timeout, `real` passes through.
type FinalizeStep = "applyThenThrow" | "throw" | "timeout" | "real";

function instrument(store: RedisSnapshotStore, steps: FinalizeStep[]) {
  const calls = { finalize: 0, getById: 0 };
  const realFinalize = store.finalize.bind(store);
  const realGetById = store.getById.bind(store);
  store.finalize = async (runId, token) => {
    const step = steps[calls.finalize] ?? "real";
    calls.finalize++;
    if (step === "throw") throw new Error(TIMEOUT);
    if (step === "timeout") {
      await sleep(CLIENT_TIMEOUT_MS);
      throw new Error(TIMEOUT);
    }
    const result = await realFinalize(runId, token);
    if (step === "applyThenThrow") throw new Error(TIMEOUT);
    return result;
  };
  store.getById = async (...args) => {
    calls.getById++;
    return realGetById(...args);
  };
  return calls;
}

async function bornRun(prisma: PrismaClient, store: RedisSnapshotStore, steps: FinalizeStep[]) {
  const env = await seedSnapshotEnvironment(prisma);
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const m = recorder();
  const writer = new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "redis-only",
    logicalRunStoreRoute: ROUTE,
    metrics: m.metrics,
  });
  const runId = generateInternalId();
  const birthId = generateInternalId();
  await writer.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: birthSnapshot(env, birthId),
  });
  expect((await store.getLatest(runId))?.id).toBe(birthId);
  // Only the transition under test is instrumented and counted.
  const calls = instrument(store, steps);
  m.writes.length = 0;
  const transitionId = generateInternalId();
  const transition = () =>
    writer.runInTransaction(runId, async (txStore) => {
      await txStore.createExecutionSnapshot(transitionInput(env, runId, transitionId, birthId));
      return "ok";
    });
  return { runId, birthId, transitionId, transition, calls, writes: m.writes };
}

describe("TaskRunExecutionSnapshotStore finalize after Postgres commit", () => {
  containerTest(
    "a finalize that applied but threw resolves, proven by read-back",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const run = await bornRun(prisma, store, ["applyThenThrow"]);

        await expect(run.transition()).resolves.toBe("ok");
        expect((await store.getLatest(run.runId))?.id).toBe(run.transitionId);
        expect(run.writes).toEqual(["written"]);
        expect(run.calls.finalize).toBe(1);
        expect((await store.readPendingState(run.runId)).prepared).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a finalize that threw without applying is retried once and resolves",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const run = await bornRun(prisma, store, ["throw"]);

        await expect(run.transition()).resolves.toBe("ok");
        expect((await store.getLatest(run.runId))?.id).toBe(run.transitionId);
        expect(run.writes).toEqual(["written"]);
        expect(run.calls.finalize).toBe(2);
        expect((await store.readPendingState(run.runId)).prepared).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "two failed finalizes fail closed and retriable, leaving the unit pending for recovery",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const run = await bornRun(prisma, store, ["throw", "throw"]);

        const error = await run.transition().then(
          () => {
            throw new Error("expected the transaction to reject");
          },
          (e: unknown) => e
        );
        expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect((error as SnapshotWriteUnavailableError).retriable).toBe(true);
        expect((error as Error).message).toContain("finalize outcome unknown");
        expect((error as SnapshotWriteUnavailableError).phase).toBe("finalize");
        expect((error as Error).message).toContain(TIMEOUT);
        expect(((error as SnapshotWriteUnavailableError).cause as Error | undefined)?.message).toBe(
          TIMEOUT
        );
        expect(run.calls.finalize).toBe(2);
        expect(run.writes).toEqual(["failed"]);
        expect((await store.readPendingState(run.runId)).prepared).toBe(true);
        expect((await store.getLatest(run.runId))?.id).toBe(run.birthId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a normal transaction makes exactly one finalize call and no read-back",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const run = await bornRun(prisma, store, []);

        await expect(run.transition()).resolves.toBe("ok");
        expect(run.calls.finalize).toBe(1);
        expect(run.calls.getById).toBe(0);
        expect(run.writes).toEqual(["written"]);
        expect((await store.getLatest(run.runId))?.id).toBe(run.transitionId);
      } finally {
        await store.quit();
      }
    }
  );

  // The read-back proof is an exceptional path that already treats a failed read as "unproven". It
  // must fail fast: a retried read against an unreachable MemoryDB multiplies the client timeout while
  // the run lock is held.
  containerTest(
    "an unreachable MemoryDB fails the proof fast instead of retrying its reads",
    async ({ prisma, redisOptions }) => {
      const client = createRedisClient(redisOptions);
      const store = new RedisSnapshotStore({ client, completedTtlMs: 60_000 });
      try {
        const run = await bornRun(prisma, store, ["timeout", "timeout"]);
        const reads = vi.spyOn(client, "readSnapshotById").mockImplementation(async () => {
          await sleep(CLIENT_TIMEOUT_MS);
          throw new Error(TIMEOUT);
        });

        const started = Date.now();
        const error = await run.transition().then(
          () => {
            throw new Error("expected the transaction to reject");
          },
          (e: unknown) => e
        );
        const elapsed = Date.now() - started;

        expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect((error as SnapshotWriteUnavailableError).retriable).toBe(true);
        expect(elapsed).toBeLessThan(2500);
        expect(readAttempts(reads, client)).toBe(1);
      } finally {
        vi.restoreAllMocks();
        await store.quit();
        await client.quit().catch(() => undefined);
      }
    }
  );

  // A noop from the retried finalize means the unit WAS applied and no pending unit remains, so a
  // proof that then fails on a read error must not send anyone to the recovery worker.
  containerTest(
    "a noop retry whose proof read fails reports an applied finalize, not an unknown outcome",
    async ({ prisma, redisOptions }) => {
      const client = createRedisClient(redisOptions);
      const store = new RedisSnapshotStore({ client, completedTtlMs: 60_000 });
      try {
        const run = await bornRun(prisma, store, ["applyThenThrow", "real"]);
        vi.spyOn(client, "readSnapshotById").mockRejectedValue(new Error(TIMEOUT));

        const error = await run.transition().then(
          () => {
            throw new Error("expected the transaction to reject");
          },
          (e: unknown) => e
        );
        vi.restoreAllMocks();

        expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect((error as SnapshotWriteUnavailableError).retriable).toBe(true);
        expect((error as Error).message).toContain(
          "finalize applied but the read-back proof failed"
        );
        expect((error as SnapshotWriteUnavailableError).phase).toBe("finalize");
        expect((error as Error).message).not.toContain("recovery worker");
        expect(run.calls.finalize).toBe(2);
        expect(run.writes).toEqual(["failed"]);
        expect((await store.readPendingState(run.runId)).prepared).toBe(false);
        expect((await store.getLatest(run.runId))?.id).toBe(run.transitionId);
      } finally {
        vi.restoreAllMocks();
        await store.quit();
        await client.quit().catch(() => undefined);
      }
    }
  );
});

// With auto-pipelining on, a call that reaches the real command is re-dispatched through a pipeline
// that copied the spied method; only calls made on the client itself are attempts by the store.
function readAttempts(spy: { mock: { contexts: unknown[] } }, client: RedisClient): number {
  return spy.mock.contexts.filter((context) => context === client).length;
}
