import type { RedisOptions } from "@internal/redis";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import type { RunEngine } from "../index.js";
import { createTestEngine, freshRunFriendlyId } from "./helpers/engineFactory.js";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

/** Both arms live in one engine, which is what a flipped organization actually runs. */
function mixedEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  return createTestEngine({
    waitpointArm: "store",
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

function triggerParams(friendlyId: string, environment: any, taskIdentifier: string) {
  return {
    number: 1,
    friendlyId,
    environment,
    taskIdentifier,
    payload: "{}",
    payloadType: "application/json",
    context: {},
    traceContext: {},
    traceId: "t12345",
    spanId: "s12345",
    workerQueue: "main",
    queue: `task/${taskIdentifier}`,
    isTest: false,
    tags: [],
  };
}

/** One legacy waitpoint and one store waitpoint, both blocking the same run. */
async function blockOnBoth(engine: RunEngine, prisma: PrismaClient, environment: any) {
  const taskIdentifier = "test-task";
  await setupBackgroundWorker(engine, environment, taskIdentifier);

  const run = await engine.trigger(
    triggerParams(freshRunFriendlyId("store"), environment, taskIdentifier),
    prisma
  );

  // The run has to be executing before it can be suspended and resumed. A run that never
  // started has no attempt to continue, so a resume assertion on it would be meaningless.
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  await engine.startRunAttempt({
    runId: dequeued[0]!.run.id,
    snapshotId: dequeued[0]!.snapshot.id,
  });

  const legacy = await engine.createManualWaitpoint({
    waitpointMintKind: "legacy",
    environmentId: environment.id,
    projectId: environment.project.id,
  });
  const store = await engine.createManualWaitpoint({
    waitpointMintKind: "store",
    environmentId: environment.id,
    projectId: environment.project.id,
  });

  expect(parseWaitpointId(legacy.waitpoint.id).format).toBe("legacy");
  expect(parseWaitpointId(store.waitpoint.id).format).toBe("b32hexW");

  await engine.blockRunWithWaitpoint({
    runId: run.id,
    waitpoints: [legacy.waitpoint.id, store.waitpoint.id],
    projectId: environment.project.id,
    organizationId: environment.organization.id,
  });

  const blocked = await engine.getRunExecutionData({ runId: run.id });
  assertNonNullable(blocked);
  expect(blocked.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

  return { run, legacyId: legacy.waitpoint.id, storeId: store.waitpoint.id };
}

async function statusOf(engine: RunEngine, runId: string) {
  const data = await engine.getRunExecutionData({ runId });
  assertNonNullable(data);
  return data.snapshot.executionStatus;
}

/**
 * The resume runs asynchronously off the completion, so "still blocked" has to be given
 * time to be wrong. Settling first means a passing assertion is evidence the run stayed
 * put, not evidence the resume had not happened yet.
 */
async function staysBlocked(engine: RunEngine, runId: string) {
  await setTimeout(1_000);
  expect(await statusOf(engine, runId)).toBe("EXECUTING_WITH_WAITPOINTS");
}

async function resumes(engine: RunEngine, runId: string) {
  await vi.waitFor(async () => expect(await statusOf(engine, runId)).toBe("EXECUTING"), {
    timeout: 10_000,
    interval: 100,
  });
}

describe("a run blocked by one waitpoint of each kind", () => {
  // The dual pending check: neither arm can see the other's waitpoint, so a resume decided
  // from one arm alone would release the run while the other half is still outstanding.
  containerTest(
    "stays blocked until both complete, legacy first",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = mixedEngine(prisma, redisOptions);

      try {
        const { run, legacyId, storeId } = await blockOnBoth(engine, prisma, environment);

        await engine.completeWaitpoint({ id: legacyId });
        await staysBlocked(engine, run.id);

        await engine.completeWaitpoint({ id: storeId });
        await resumes(engine, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "stays blocked until both complete, store first",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = mixedEngine(prisma, redisOptions);

      try {
        const { run, legacyId, storeId } = await blockOnBoth(engine, prisma, environment);

        await engine.completeWaitpoint({ id: storeId });
        await staysBlocked(engine, run.id);

        await engine.completeWaitpoint({ id: legacyId });
        await resumes(engine, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Clearing has the same trap in reverse: an empty partition must not be read as "clear
  // everything", or resuming a mixed run would wipe the other arm's edges.
  containerTest("clears both arms' edges on resume", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = mixedEngine(prisma, redisOptions);

    try {
      const { run, legacyId, storeId } = await blockOnBoth(engine, prisma, environment);

      await engine.completeWaitpoint({ id: legacyId });
      await engine.completeWaitpoint({ id: storeId });
      await resumes(engine, run.id);

      const legacyEdges = await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } });
      expect(legacyEdges).toBe(0);
    } finally {
      await engine.quit();
    }
  });
});
