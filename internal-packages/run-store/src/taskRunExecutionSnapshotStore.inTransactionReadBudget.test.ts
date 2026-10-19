// A redis-primary forward-carry reads MemoryDB while the owning Postgres transaction is open. Those
// reads get one attempt each, so a MemoryDB blip fails the write fast and closed instead of retrying
// past the transaction timeout. Real Postgres + real Redis: a CLIENT PAUSE stalls the server, so the
// head read hits the client's real command timeout.
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  SnapshotWriteUnavailableError,
  TaskRunExecutionSnapshotStore,
} from "./taskRunExecutionSnapshotStore.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";
const TRANSACTION_TIMEOUT_MS = 1_500;

// A client of its own on the test database whose interactive transactions expire after
// TRANSACTION_TIMEOUT_MS: Prisma applies a client-level timeout to every transaction that does not
// pass its own, which the run store's transactions do not.
function shortTransactionClient(uri: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: uri } },
    transactionOptions: { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 2_000 },
  });
}
// The client's command timeout: four of them outlive the transaction, one does not.
const COMMAND_TIMEOUT_MS = 450;
// Longer than one command timeout, but over before a retrying read's second attempt (one timeout plus
// the first 50 ms retry delay) would give up: a retrying head read would succeed, a single attempt fails.
const PAUSE_MS = 700;

type Env = Awaited<ReturnType<typeof seedSnapshotEnvironment>>;

function forwardCarry(env: Env, runId: string, id: string, previousSnapshotId: string, wp: string) {
  return {
    id,
    createdAt: new Date(),
    run: { id: runId, status: "DEQUEUED" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "PENDING_EXECUTING" as const, description: "Run dequeued" },
    previousSnapshotId,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
    // Refs with no records resolver: carry the head's cycle forward.
    completedWaitpoints: [{ id: wp, index: 0 }],
  };
}

async function seedRunWithCycle(
  prisma: PrismaClient,
  writer: TaskRunExecutionSnapshotStore
): Promise<{ env: Env; runId: string; headId: string; waitpointId: string }> {
  const env = await seedSnapshotEnvironment(prisma);
  const runId = generateInternalId();
  const birthId = generateInternalId();
  const headId = generateInternalId();
  const waitpointId = generateInternalId();
  await writer.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: {
      id: birthId,
      createdAt: new Date(),
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  });
  await writer.createExecutionSnapshot({
    id: headId,
    createdAt: new Date(),
    run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING", description: "Waitpoint completed" },
    previousSnapshotId: birthId,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
    completedWaitpoints: [{ id: waitpointId, index: 0 }],
    resolveCompletedWaitpointRecords: async () => [
      {
        id: waitpointId,
        friendlyId: "waitpoint_ok",
        type: "MANUAL",
        completedAt: "2026-01-01T00:00:00.000Z",
        outputType: "application/json",
        outputIsError: false,
        output: { inline: "42" },
      },
    ],
  });
  return { env, runId, headId, waitpointId };
}

describe("TaskRunExecutionSnapshotStore in-transaction MemoryDB read budget", () => {
  containerTest(
    "a forward-carry read that times out fails the write fast, inside the transaction timeout",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const client = createRedisClient({ ...redisOptions, commandTimeout: COMMAND_TIMEOUT_MS });
      const admin = createRedisClient(redisOptions, { onError: () => {} });
      // Pause the server just before the next head read is sent, through the store's readiness seam.
      let pauseBeforeHeadRead = false;
      let pausedAt = 0;
      const store = new RedisSnapshotStore({
        client,
        completedTtlMs: 60_000,
        beforeCommand: async (operation) => {
          if (operation !== "getLatest" || !pauseBeforeHeadRead) return;
          pauseBeforeHeadRead = false;
          await admin.call("CLIENT", "PAUSE", String(PAUSE_MS), "ALL");
          pausedAt = Date.now();
        },
      });
      const shortTx = shortTransactionClient(postgresContainer.getConnectionUri());
      const delegate = new PostgresRunStore({ prisma: shortTx, readOnlyPrisma: shortTx });
      const writer = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        logicalRunStoreRoute: ROUTE,
      });

      try {
        const { env, runId, headId, waitpointId } = await seedRunWithCycle(prisma, writer);

        pauseBeforeHeadRead = true;
        const started = Date.now();
        const failed = await writer
          .createExecutionSnapshot(
            forwardCarry(env, runId, generateInternalId(), headId, waitpointId)
          )
          .then(
            () => undefined,
            (error: unknown) => error
          );
        const elapsedMs = Date.now() - started;
        // Let the pause run out before the assertions below read Redis.
        await sleep(Math.max(0, pausedAt + PAUSE_MS - Date.now()));

        expect(pausedAt).toBeGreaterThan(0);
        expect(failed).toBeInstanceOf(SnapshotWriteUnavailableError);
        expect((failed as SnapshotWriteUnavailableError).retriable).toBe(true);
        // The head read failed it, so the cycle read was never reached.
        expect((failed as Error).message).toMatch(/forward-carry head read failed/);
        // Thrown inside the transaction, which rolled back: the default phase.
        expect((failed as SnapshotWriteUnavailableError).phase).toBe("transaction");
        expect(elapsedMs).toBeLessThan(TRANSACTION_TIMEOUT_MS);

        // Nothing prepared or pending, and the head did not move.
        expect(await store.readPendingState(runId)).toEqual({
          prepared: false,
          quarantined: false,
        });
        expect((await store.getLatest(runId))?.id).toBe(headId);

        // The connection was released: the next write on the same run goes through.
        const nextId = generateInternalId();
        await writer.createExecutionSnapshot(forwardCarry(env, runId, nextId, headId, waitpointId));
        const head = await store.getLatest(runId);
        expect(head?.id).toBe(nextId);
        const cycle = await store.getSnapshotCompletedWaitpoints(runId, nextId);
        expect(cycle.present).toBe(true);
        expect(cycle.order).toEqual([waitpointId]);
        expect(cycle.records.map((r) => r.id)).toEqual([waitpointId]);
      } finally {
        await store.quit();
        await client.quit().catch(() => undefined);
        await admin.quit().catch(() => undefined);
        await shortTx.$disconnect();
      }
    }
  );
});
