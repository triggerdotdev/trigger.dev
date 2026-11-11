import { createRedisClient } from "@internal/redis";
import {
  RunEngine,
  StoreWaitpointCoordinator,
  WaitpointStoreCoordinator,
} from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { parseWaitpointId, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { Redis, type RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { createWaitpointStoreEnabledResolver } from "~/v3/utils/waitpointStoreEnabled.server";

vi.setConfig({ testTimeout: 120_000 });

// test/setup.ts replaces the app engine singleton with a no-op. Load the real module instead; it
// resolves `engine` through the production singleton registry, seeded below with a real engine.
vi.doUnmock("~/v3/runEngine.server");

const addressingKey = "chat-session-1";
const io = "in" as const;

async function setup(prisma: PrismaClient, redisOptions: RedisOptions, storeEnabled: boolean) {
  // Match production, where migration 20260705230000 dropped this FK for native waitpoint ids.
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"'
  );
  // The store has its own Redis user, so its failure cannot reach the engine or the cache.
  const admin = createRedisClient(redisOptions);
  const storeUser = `waitpoint_${crypto.randomUUID().replaceAll("-", "")}`;
  const password = crypto.randomUUID();
  await admin.call("ACL", "SETUSER", storeUser, "on", `>${password}`, "~*", "+@all");
  const storeClient = createRedisClient({ ...redisOptions, username: storeUser, password });
  const store = new WaitpointStoreCoordinator({ client: storeClient });

  const engine = new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    // The production resolver: the organization's featureFlags row decides.
    waitpointStoreEnabled: createWaitpointStoreEnabledResolver(() => undefined, prisma),
    waitpointStore: store,
    waitpointFanoutStore: store,
    waitpointRouting: {
      store: new StoreWaitpointCoordinator({ store }),
      mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
    },
  });

  const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  await prisma.organization.update({
    where: { id: env.organization.id },
    data: { featureFlags: { waitpointStoreEnabled: storeEnabled } },
  });
  await setupBackgroundWorker(engine, env, ["session-agent"]);

  const friendlyId = RunId.generate().friendlyId;
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId,
      environment: env,
      taskIdentifier: "session-agent",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t_${friendlyId}`,
      spanId: `s_${friendlyId}`,
      workerQueue: "main",
      queue: "task/session-agent",
      isTest: false,
      tags: [],
    },
    prisma
  );
  const dequeued = await vi.waitFor(
    async () => {
      const d = await engine.dequeueFromWorkerQueue({
        consumerId: "session-agent",
        workerQueue: "main",
        blockingPopTimeoutSeconds: 1,
      });
      expect(d.length, "run never reached the worker queue").toBe(1);
      return d;
    },
    { timeout: 10_000, interval: 100 }
  );
  await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued[0]!.snapshot.id });

  // Bind the real webapp modules to this engine and to a real cache client on the same Redis.
  const cache = new Redis({ ...redisOptions, keyPrefix: "tr:" });
  (globalThis as any).__trigger_singletons ??= {};
  const singletons = (globalThis as any).__trigger_singletons;
  singletons.RunEngine = engine;
  singletons.sessionStreamWaitpointCache = cache;
  vi.resetModules();
  const { completeSessionStreamWaitpoints } =
    await import("~/services/realtime/sessionChannelAppend.server");
  const { addSessionStreamWaitpoint, drainSessionStreamWaitpoints } =
    await import("~/services/sessionStreamWaitpointCache.server");

  // What the session-streams .wait() route and the SDK's token wait do: an untimed run-bound
  // MANUAL waitpoint, registered on the channel, with the run blocked on it.
  const { waitpoint } = await engine.createManualWaitpoint({
    runId: run.id,
    environmentId: env.id,
    projectId: env.project.id,
    organizationId: env.organization.id,
  });
  await addSessionStreamWaitpoint(env.id, addressingKey, io, waitpoint.id);
  const blockOperation = storeEnabled
    ? await engine.waitpointSystem.buildStoreBlockOperation({
        runId: run.id,
        waitpointId: waitpoint.id,
        organizationId: env.organization.id,
      })
    : undefined;
  await engine.blockRunWithWaitpoint({
    runId: run.id,
    waitpoints: [waitpoint.id],
    projectId: env.project.id,
    organizationId: env.organization.id,
    ...(blockOperation ? { blockOperation, expectedEnvironmentId: env.id } : {}),
  });

  const executionStatus = async () =>
    (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus;
  const waitpointStatus = async () =>
    storeEnabled
      ? (
          await engine.getStoreDateTimeWaitpoint({
            waitpointId: waitpoint.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          })
        )?.status
      : (await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } }))?.status;

  return {
    waitpointId: waitpoint.id,
    executionStatus,
    waitpointStatus,
    append: (part: string) =>
      completeSessionStreamWaitpoints(env as AuthenticatedEnvironment, addressingKey, io, part),
    // A real server-side rejection of every native-store command (NOPERM), then recovery.
    rejectStoreCommands: () => admin.call("ACL", "SETUSER", storeUser, "-@all"),
    restoreStoreCommands: () => admin.call("ACL", "SETUSER", storeUser, "+@all"),
    // Removes the native record itself, so every completion fails with WaitpointNotFoundError.
    deleteNativeRecord: () => admin.del(`wp:v1:{${waitpoint.id}}`),
    registeredIds: () => drainSessionStreamWaitpoints(env.id, addressingKey, io),
    async cleanup() {
      await engine.quit();
      await store.quit();
      storeClient.disconnect();
      cache.disconnect();
      await admin.call("ACL", "DELUSER", storeUser);
      admin.disconnect();
    },
  };
}

describe("completeSessionStreamWaitpoints after a failed completion", () => {
  // Catches: a native waiter dropped when its completion fails after the drain, so it never wakes.
  containerTest(
    "native MANUAL waiter is woken by the next append",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions, true);
      try {
        expect(parseWaitpointId(t.waitpointId).format).not.toBe("legacy");
        expect(await t.executionStatus()).toBe("EXECUTING_WITH_WAITPOINTS");

        await t.rejectStoreCommands();
        try {
          await t.append('{"n":1}');
        } finally {
          await t.restoreStoreCommands();
        }
        expect(await t.waitpointStatus(), "first completion should have failed").toBe("PENDING");

        await t.append('{"n":2}');

        await expect
          .poll(t.waitpointStatus, {
            timeout: 5_000,
            interval: 100,
            message: "second append did not complete the native waitpoint",
          })
          .toBe("COMPLETED");
        await expect
          .poll(t.executionStatus, { timeout: 10_000, interval: 100, message: "run never resumed" })
          .toBe("EXECUTING");
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: native-only re-registration leaking into the flag-off legacy branch.
  containerTest(
    "flag-off legacy waiter is not re-registered (unchanged behaviour)",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions, false);
      try {
        expect(parseWaitpointId(t.waitpointId).format).toBe("legacy");
        expect(await t.executionStatus()).toBe("EXECUTING_WITH_WAITPOINTS");

        // A real Postgres rejection of the completion write, then recovery.
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "Waitpoint" ADD CONSTRAINT reject_completion CHECK (status <> 'COMPLETED') NOT VALID`
        );
        try {
          await t.append('{"n":1}');
        } finally {
          await prisma.$executeRawUnsafe(
            `ALTER TABLE "Waitpoint" DROP CONSTRAINT reject_completion`
          );
        }
        expect(await t.waitpointStatus(), "first completion should have failed").toBe("PENDING");

        await t.append('{"n":2}');

        expect(await t.waitpointStatus()).toBe("PENDING");
        expect(await t.executionStatus()).toBe("EXECUTING_WITH_WAITPOINTS");
      } finally {
        await t.cleanup();
      }
    }
  );

  // Catches: a native waiter with no record re-registered, with a fresh TTL, on every append.
  containerTest(
    "native waiter with a missing record is not re-registered",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions, true);
      try {
        expect(parseWaitpointId(t.waitpointId).format).not.toBe("legacy");
        expect(await t.deleteNativeRecord(), "native record key not found").toBe(1);

        await t.append('{"n":1}');

        expect(await t.registeredIds()).toEqual([]);
        expect(await t.executionStatus()).toBe("EXECUTING_WITH_WAITPOINTS");
      } finally {
        await t.cleanup();
      }
    }
  );
});
