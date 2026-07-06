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
import {
  RunId,
  classifyKind,
  generateInternalId,
  generateRunOpsId,
} from "@trigger.dev/core/v3/isomorphic";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("RunEngineTriggerTaskService — child run residency inheritance", () => {
  // Helper: stand up an engine + service wired for a single (real) Postgres/Redis
  // pair. Returns the service plus the authenticated environment and a registered
  // task identifier.
  async function setupResidencyService(prisma: any, redisOptions: any) {
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": {
            name: "small-1x" as const,
            cpu: 0.5,
            memory: 0.5,
            centsPerMs: 0.0001,
          },
        },
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });
    onTestFinished(() => engine.quit());

    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const taskIdentifier = "residency-task";
    await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

    const queuesManager = new DefaultQueueManager(prisma, engine);
    const idempotencyKeyConcern = new IdempotencyKeyConcern(
      prisma,
      engine,
      new MockTraceEventConcern()
    );

    const triggerTaskService = new RunEngineTriggerTaskService({
      engine,
      prisma,
      payloadProcessor: new MockPayloadProcessor(),
      queueConcern: queuesManager,
      idempotencyKeyConcern,
      validator: new MockTriggerTaskValidator(),
      traceEventConcern: new MockTraceEventConcern(),
      tracer: trace.getTracer("test", "0.0.0"),
      metadataMaximumSize: 1024 * 1024 * 1,
    });

    return { engine, authenticatedEnvironment, taskIdentifier, triggerTaskService };
  }

  containerTest(
    "root run mints by the env flag (cuid when split is off)",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "root" } },
      });

      expect(result?.run.friendlyId).toBeDefined();
      // Split disabled in CI ⇒ flag resolves "cuid".
      expect(classifyKind(result!.run.friendlyId)).toBe("cuid");
    }
  );

  containerTest(
    "child of a LEGACY (cuid) parent is minted cuid (born LEGACY)",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      // Root parent — cuid in CI (split off).
      const parent = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "parent" } },
      });
      expect(classifyKind(parent!.run.friendlyId)).toBe("cuid");

      const child = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "child" }, options: { parentRunId: parent!.run.friendlyId } },
      });

      expect(classifyKind(child!.run.friendlyId)).toBe("cuid");
    }
  );

  containerTest(
    "child of a NEW (run-ops id) parent is minted run-ops id (born NEW)",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      // Construct a NEW-resident parent directly by minting a run-ops id friendlyId
      // and creating its run row, so the child inherits NEW by id-shape alone
      // (no marker needed). We trigger the parent with an explicit run-ops id via
      // the runFriendlyId option so the row physically exists for the parent
      // lookup the child path performs.
      // v1 id (version "1" at index 25) → classifies NEW
      const parentFriendlyId = RunId.toFriendlyId(generateRunOpsId());
      expect(classifyKind(parentFriendlyId)).toBe("runOpsId");

      const parent = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "parent" } },
        options: { runFriendlyId: parentFriendlyId },
      });
      expect(parent!.run.friendlyId).toBe(parentFriendlyId);

      const child = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "child" }, options: { parentRunId: parentFriendlyId } },
      });

      expect(classifyKind(child!.run.friendlyId)).toBe("runOpsId");
    }
  );

  containerTest(
    "caller-supplied runFriendlyId wins verbatim and skips residency inheritance",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      // Explicit cuid id for the run, and a run-ops id/NEW parent id.
      const explicitFriendlyId = RunId.toFriendlyId(generateInternalId());
      const parentFriendlyId = RunId.toFriendlyId(generateRunOpsId());
      expect(classifyKind(explicitFriendlyId)).toBe("cuid");
      expect(classifyKind(parentFriendlyId)).toBe("runOpsId");

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "explicit" }, options: { parentRunId: parentFriendlyId } },
        options: { runFriendlyId: explicitFriendlyId },
      });

      // Caller-supplied id wins verbatim — NOT re-minted to run-ops id despite the NEW parent.
      expect(result!.run.friendlyId).toBe(explicitFriendlyId);
    }
  );
});
