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
import {
  createEngine,
  createService,
  nameDeploymentWithExternalId,
  RecordingExternalDeploymentCache,
} from "./triggerTask.externalDeploymentId.helpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("triggerTask external deployment id", () => {
  containerTest(
    "pins the run to the deployment holding the id, not to whatever is current",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "pinned-task";

      const targetWorker = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await nameDeploymentWithExternalId(prisma, targetWorker.worker.id, "commit-target");

      const currentWorker = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const cache = new RecordingExternalDeploymentCache();
      const service = createService(prisma, engine, cache);

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-target" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING");
      expect(run.lockedToVersionId).toBe(targetWorker.worker.id);
      expect(run.taskVersion).toBe(targetWorker.worker.version);
      expect(run.lockedToVersionId).not.toBe(currentWorker.worker.id);
      expect((run.annotations as Record<string, unknown>).externalDeploymentId).toBe(
        "commit-target"
      );

      expect(cache.writes.map((w) => w.externalId)).toEqual(["commit-target"]);
    }
  );

  containerTest(
    "an explicit version wins over an external deployment id, and the id is not even resolved",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "precedence-task";

      const versionWorker = await setupBackgroundWorker(engine, environment, taskIdentifier);
      const idWorker = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await nameDeploymentWithExternalId(prisma, idWorker.worker.id, "commit-loser");

      const cache = new RecordingExternalDeploymentCache();
      const service = createService(prisma, engine, cache);

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: {
          payload: { test: "x" },
          options: {
            lockToVersion: versionWorker.worker.version,
            externalDeploymentId: "commit-loser",
          },
        },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING");
      expect(run.lockedToVersionId).toBe(versionWorker.worker.id);
      expect(run.taskVersion).toBe(versionWorker.worker.version);

      expect(cache.gets).toEqual([]);
      expect((run.annotations as Record<string, unknown>).externalDeploymentId).toBeUndefined();
    }
  );

  containerTest(
    "a trigger carrying no id runs on current, exactly as before",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "plain-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const cache = new RecordingExternalDeploymentCache();
      const service = createService(prisma, engine, cache);

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING");
      expect(run.lockedToVersionId).toBeNull();
      expect(cache.gets).toEqual([]);
    }
  );
});
