import { describe, expect, onTestFinished, vi } from "vitest";

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

import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { NoopExternalDeploymentCache } from "~/services/externalDeploymentCache.server";
import {
  createEngine,
  createService,
  RecordingExternalDeploymentCache,
} from "./triggerTask.externalDeploymentId.helpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("triggerTask external deployment id", () => {
  containerTest(
    "parks a run whose id nothing holds, recording the id in annotations",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "parked-task";

      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const service = createService(prisma, engine, new NoopExternalDeploymentCache());

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-unknown" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING_VERSION");
      expect(run.statusReason).toBe("EXTERNAL_DEPLOYMENT_PENDING");
      expect(run.lockedToVersionId).toBeNull();
      expect((run.annotations as Record<string, unknown>).externalDeploymentId).toBe(
        "commit-unknown"
      );
    }
  );

  containerTest(
    "never parks in development, where no deployment can ever hold the id",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
      const taskIdentifier = "dev-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const cache = new RecordingExternalDeploymentCache();
      const service = createService(prisma, engine, cache);

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-unknown" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING");
      expect(run.statusReason).toBeNull();
      expect(cache.gets).toEqual([]);
      expect((run.annotations as Record<string, unknown>).externalDeploymentId).toBe(
        "commit-unknown"
      );
    }
  );

  containerTest(
    "parks a run whose id is held only by an in-flight deployment",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "inflight-task";

      const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

      await prisma.workerDeployment.update({
        where: { workerId: worker.worker.id },
        data: { externalId: "commit-building", status: "BUILDING" },
      });

      const cache = new RecordingExternalDeploymentCache();
      const service = createService(prisma, engine, cache);

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-building" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING_VERSION");
      expect(run.lockedToVersionId).toBeNull();

      expect(cache.writes).toEqual([]);
    }
  );
});
