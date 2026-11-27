import { describe, expect, onTestFinished, vi } from "vitest";

// db.server + splitMode are mocked so the idempotency dedup client resolves to
// the container prisma passed into the concern (split stays off).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
}));

vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("RunEngineTriggerTaskService for compute-only organizations", () => {
  async function setup(prisma: any, redisOptions: any, type: "PRODUCTION" | "DEVELOPMENT") {
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
        },
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });
    onTestFinished(() => engine.quit());

    const environment = await setupAuthenticatedEnvironment(prisma, type);
    environment.organization.featureFlags = { computeOnly: true };
    const taskIdentifier = "compute-only-task";
    await setupBackgroundWorker(engine, environment, taskIdentifier);

    const service = new RunEngineTriggerTaskService({
      engine,
      prisma,
      payloadProcessor: new MockPayloadProcessor(),
      queueConcern: new DefaultQueueManager(prisma, engine),
      idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
      validator: new MockTriggerTaskValidator(),
      traceEventConcern: new MockTraceEventConcern(),
      tracer: trace.getTracer("test", "0.0.0"),
      metadataMaximumSize: 1024 * 1024,
    });

    return { environment, taskIdentifier, service };
  }

  // Catches: a compute-only org's deployed trigger falling back to a container lane when its
  // version has no compute template, instead of being refused.
  containerTest(
    "refuses a deployed trigger whose version has no compute template",
    async ({ prisma, redisOptions }) => {
      const { environment, taskIdentifier, service } = await setup(
        prisma,
        redisOptions,
        "PRODUCTION"
      );

      await expect(
        service.call({ taskId: taskIdentifier, environment, body: { payload: {} } })
      ).rejects.toThrow("Deploy again and trigger the new version");
      expect(await prisma.taskRun.count({ where: { runtimeEnvironmentId: environment.id } })).toBe(
        0
      );
    }
  );

  // Catches: the compute-only pin reaching `trigger dev` runs.
  containerTest("leaves dev runs alone", async ({ prisma, redisOptions }) => {
    const { environment, taskIdentifier, service } = await setup(
      prisma,
      redisOptions,
      "DEVELOPMENT"
    );

    const result = await service.call({
      taskId: taskIdentifier,
      environment,
      body: { payload: {} },
    });

    const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result!.run.id } });
    expect((run.annotations as Record<string, unknown> | null)?.computeOnly).toBeUndefined();
  });
});
