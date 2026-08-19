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
    "trusts a cache hit without querying Postgres",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "cached-pin-task";

      const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const cache = new RecordingExternalDeploymentCache([
        {
          environmentId: environment.id,
          externalId: "commit-cached",
          entry: {
            workerId: worker.worker.id,
            version: worker.worker.version,
            sdkVersion: "",
            cliVersion: "",
          },
        },
      ]);

      const service = createService(prisma, engine, cache);

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-cached" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING");
      expect(run.lockedToVersionId).toBe(worker.worker.id);
      expect(cache.gets).toEqual([{ environmentId: environment.id, externalId: "commit-cached" }]);
      expect(cache.writes).toEqual([]);
    }
  );

  containerTest(
    "resolves to the highest version when several deployed deployments hold the id",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "forced-task";

      const older = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await prisma.backgroundWorker.update({
        where: { id: older.worker.id },
        data: { version: "20260807.9" },
      });
      await prisma.workerDeployment.update({
        where: { workerId: older.worker.id },
        data: {
          externalId: "commit-forced",
          version: "20260807.9",
          shortCode: "short_code_20260807.9",
        },
      });

      const newer = await setupBackgroundWorker(engine, environment, taskIdentifier);
      await prisma.backgroundWorker.update({
        where: { id: newer.worker.id },
        data: { version: "20260807.10" },
      });
      await prisma.workerDeployment.update({
        where: { workerId: newer.worker.id },
        data: {
          externalId: "commit-forced",
          version: "20260807.10",
          shortCode: "short_code_20260807.10",
        },
      });

      const service = createService(prisma, engine, new NoopExternalDeploymentCache());

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-forced" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.lockedToVersionId).toBe(newer.worker.id);
      expect(run.taskVersion).toBe("20260807.10");
    }
  );

  containerTest(
    "an id is environment-scoped, so a deployment in another environment never resolves it",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "scoped-task";

      const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const otherEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "staging-scoped",
          type: "STAGING",
          projectId: environment.project.id,
          organizationId: environment.organization.id,
          apiKey: "tr_stg_scoped",
          pkApiKey: "pk_stg_scoped",
          shortcode: "stg-scoped",
        },
      });

      await prisma.workerDeployment.create({
        data: {
          friendlyId: "deployment_elsewhere",
          contentHash: "hash",
          shortCode: "sc_elsewhere",
          version: worker.worker.version,
          status: "DEPLOYED",
          externalId: "commit-elsewhere",
          projectId: environment.project.id,
          environmentId: otherEnvironment.id,
        },
      });

      const cache = new RecordingExternalDeploymentCache([
        {
          environmentId: otherEnvironment.id,
          externalId: "commit-elsewhere",
          entry: {
            workerId: worker.worker.id,
            version: worker.worker.version,
            sdkVersion: "",
            cliVersion: "",
          },
        },
      ]);
      const service = createService(prisma, engine, cache);

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-elsewhere" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING_VERSION");
      expect(run.lockedToVersionId).toBeNull();
      expect(cache.gets).toEqual([
        { environmentId: environment.id, externalId: "commit-elsewhere" },
      ]);
      expect(cache.missing).toEqual([
        { environmentId: environment.id, externalId: "commit-elsewhere" },
      ]);
    }
  );
});
