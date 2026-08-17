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

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import type { PrismaClient } from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import {
  type ExternalDeploymentCache,
  type ExternalDeploymentCacheEntry,
  NoopExternalDeploymentCache,
} from "~/services/externalDeploymentCache.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

class RecordingExternalDeploymentCache implements ExternalDeploymentCache {
  readonly gets: Array<{ environmentId: string; externalId: string }> = [];
  readonly writes: Array<{ externalId: string; entry: ExternalDeploymentCacheEntry }> = [];

  constructor(private readonly entries = new Map<string, ExternalDeploymentCacheEntry>()) {}

  readonly missing: string[] = [];

  async get(environmentId: string, externalId: string) {
    this.gets.push({ environmentId, externalId });

    const entry = this.entries.get(externalId);

    if (entry) {
      return { outcome: "deployed" as const, entry };
    }

    return this.missing.includes(externalId) ? { outcome: "missing" as const } : null;
  }

  async setIfNewer(
    _environmentId: string,
    externalId: string,
    entry: ExternalDeploymentCacheEntry
  ) {
    this.writes.push({ externalId, entry });
    this.entries.set(externalId, entry);
  }

  async setMissing(_environmentId: string, externalId: string) {
    this.missing.push(externalId);
  }
}

function createEngine(prisma: PrismaClient, redisOptions: unknown) {
  const engine = new RunEngine({
    prisma,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker: { redis: redisOptions as any, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue: { redis: redisOptions as any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runLock: { redis: redisOptions as any },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });

  return engine;
}

function createService(
  prisma: PrismaClient,
  engine: RunEngine,
  externalDeploymentCache: ExternalDeploymentCache
) {
  return new RunEngineTriggerTaskService({
    engine,
    prisma,
    payloadProcessor: new MockPayloadProcessor(),
    queueConcern: new DefaultQueueManager(prisma, engine),
    idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
    validator: new MockTriggerTaskValidator(),
    traceEventConcern: new MockTraceEventConcern(),
    tracer: trace.getTracer("test", "0.0.0"),
    metadataMaximumSize: 1024 * 1024,
    externalDeploymentCache,
  });
}

async function nameDeploymentWithExternalId(
  prisma: PrismaClient,
  workerId: string,
  externalId: string
) {
  await prisma.workerDeployment.update({ where: { workerId }, data: { externalId } });
}

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

  containerTest(
    "trusts a cache hit without querying Postgres",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "cached-pin-task";

      const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const cache = new RecordingExternalDeploymentCache(
        new Map([
          [
            "commit-cached",
            {
              workerId: worker.worker.id,
              version: worker.worker.version,
              sdkVersion: "",
              cliVersion: "",
            },
          ],
        ])
      );

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

      const service = createService(prisma, engine, new NoopExternalDeploymentCache());

      const result = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" }, options: { externalDeploymentId: "commit-elsewhere" } },
      });

      assertNonNullable(result);

      const run = await prisma.taskRun.findFirstOrThrow({ where: { id: result.run.id } });

      expect(run.status).toBe("PENDING_VERSION");
      expect(run.lockedToVersionId).toBeNull();
    }
  );
});
