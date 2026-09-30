import { describe, expect, onTestFinished, vi } from "vitest";

// Module singletons are replaced so importing the presenters doesn't build app-wide clients;
// every test passes a real testcontainers Prisma client and RunEngine instead.
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return {
    prisma: {},
    $replica: {},
    sqlDatabaseSchema: Prisma.sql([`public`]),
    runOpsNewPrisma: {},
    runOpsLegacyPrisma: {},
  };
});
vi.mock("~/v3/runEngine.server", () => ({ engine: {} }));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));
// Points the presenter's ClickHouse lookups at the test container's client.
const clickhouseRef = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => clickhouseRef.client },
}));

import { ClickHouse } from "@internal/clickhouse";
import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { QueueAllocationPresenter } from "~/presenters/v3/QueueAllocationPresenter.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import { toPublicQueueItem } from "~/presenters/v3/QueueRetrievePresenter.server";
import { ArchiveQueueService } from "~/v3/services/archiveQueue.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Environment = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

function buildEngine(prisma: PrismaClient, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
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
}

async function createQueue(
  prisma: PrismaClient,
  environment: Environment,
  name: string,
  data: {
    concurrencyLimit?: number | null;
    totalConcurrencyLimit?: number | null;
    archivedAt?: Date | null;
    paused?: boolean;
  } = {}
) {
  return prisma.taskQueue.create({
    data: {
      friendlyId: generateFriendlyId("queue"),
      name,
      orderableName: name,
      type: "NAMED",
      version: "V2",
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      ...data,
    },
  });
}

/** Promotes a deploy without the earlier tasks, leaving their queues behind. */
async function deployWithout(engine: RunEngine, environment: Environment) {
  return setupBackgroundWorker(engine, environment, "replacement-task");
}

async function triggerOnQueue(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: Environment,
  taskIdentifier: string,
  queue: string
) {
  return engine.trigger(
    {
      number: 1,
      friendlyId: generateFriendlyId("run"),
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue,
      isTest: false,
      tags: [],
    },
    prisma
  );
}

describe("QueueListPresenter archived filter", () => {
  containerTest(
    "exclude hides archived queues across list, search and counts; include keeps them",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      await createQueue(prisma, environment, "alpha");
      await createQueue(prisma, environment, "beta");
      await createQueue(prisma, environment, "alpha-old", { archivedAt: new Date() });

      const presenter = new QueueListPresenter(25, prisma, prisma, engine);

      const excluded = await presenter.call({
        environment,
        page: 1,
        includeLimits: true,
        archived: "exclude",
      });
      expect(excluded.queues.map((q) => q.name).sort()).toEqual(["alpha", "beta"]);
      expect(excluded.totalQueues).toBe(2);

      const searched = await presenter.call({
        environment,
        page: 1,
        query: "alpha",
        includeLimits: true,
        archived: "exclude",
      });
      expect(searched.queues.map((q) => q.name)).toEqual(["alpha"]);

      const included = await presenter.call({
        environment,
        page: 1,
        includeLimits: true,
        archived: "include",
      });
      expect(included.queues.map((q) => q.name).sort()).toEqual(["alpha", "alpha-old", "beta"]);
      expect(included.queues.find((q) => q.name === "alpha-old")?.archivedAt).not.toBeNull();

      // The default (public API, AI filter) is unchanged.
      const defaulted = await presenter.call({ environment, page: 1 });
      expect(defaulted.totalQueues).toBe(3);
      expect(defaulted.activeArchivedQueues).toBeUndefined();
    }
  );

  containerTest(
    "returns archived queues with queued runs as active, and skips idle archived queues",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const taskIdentifier = "busy-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);
      const busyQueue = `task/${taskIdentifier}`;
      await prisma.taskQueue.update({
        where: {
          runtimeEnvironmentId_name: { runtimeEnvironmentId: environment.id, name: busyQueue },
        },
        // The engine test helper creates legacy V1 rows; deployed queues are V2.
        data: { archivedAt: new Date(), version: "V2" },
      });
      await createQueue(prisma, environment, "idle-archived", { archivedAt: new Date() });

      await triggerOnQueue(engine, prisma, environment, taskIdentifier, busyQueue);

      const presenter = new QueueListPresenter(25, prisma, prisma, engine);
      const result = await presenter.call({
        environment,
        page: 1,
        includeLimits: true,
        archived: "exclude",
        detectArchivedActivity: true,
      });

      // Task queues are listed without their "task/" prefix.
      expect(result.queues.map((q) => q.name)).not.toContain(taskIdentifier);
      expect(result.activeArchivedQueues?.map((q) => q.name)).toEqual([taskIdentifier]);
      expect(result.activeArchivedQueues?.[0]?.queued).toBe(1);

      // With "Show archived" on, activity is still detected so the row can be badged.
      const shown = await presenter.call({
        environment,
        page: 1,
        includeLimits: true,
        archived: "include",
        detectArchivedActivity: true,
      });
      expect(shown.queues.map((q) => q.name)).toContain(taskIdentifier);
      expect(shown.activeArchivedQueues?.map((q) => q.name)).toEqual([taskIdentifier]);
    }
  );
});

describe("public queue shape", () => {
  containerTest(
    "the public API item never exposes archive state",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await createQueue(prisma, environment, "archived", { archivedAt: new Date() });

      const presenter = new QueueListPresenter(25, prisma, prisma, engine);
      const { queues } = await presenter.call({ environment, page: 1 });
      const [queue] = queues;
      expect(queue?.archivedAt).not.toBeNull();

      const publicItem = toPublicQueueItem(queue!);
      expect(publicItem).not.toHaveProperty("archivedAt");
    }
  );
});

describe("QueueAllocationPresenter", () => {
  containerTest("excludes archived queues from the allocated sum", async ({ prisma }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await createQueue(prisma, environment, "emails", { concurrencyLimit: 20 });
    await createQueue(prisma, environment, "images", { concurrencyLimit: 30 });
    await createQueue(prisma, environment, "old", {
      concurrencyLimit: 25,
      archivedAt: new Date(),
    });

    const allocation = await new QueueAllocationPresenter(prisma, prisma).call({
      environment: { ...environment, maximumConcurrencyLimit: 100 },
    });

    expect(allocation).toEqual({ totalQueues: 2, allocated: 50, unlimitedCount: 0 });

    // With archiving disabled for the org, the tile counts every queue, like the list.
    const unfiltered = await new QueueAllocationPresenter(prisma, prisma).call({
      environment: { ...environment, maximumConcurrencyLimit: 100 },
      excludeArchived: false,
    });
    expect(unfiltered).toEqual({ totalQueues: 3, allocated: 75, unlimitedCount: 0 });
  });
});

describe("ArchiveQueueService", () => {
  containerTest(
    "archives an idle queue without touching limits, overrides, paused state or worker links",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { worker } = await setupBackgroundWorker(engine, environment, "idle-task");
      await deployWithout(engine, environment);
      const overriddenAt = new Date("2026-09-02T00:00:00Z");
      const queue = await prisma.taskQueue.update({
        where: {
          runtimeEnvironmentId_name: {
            runtimeEnvironmentId: environment.id,
            name: "task/idle-task",
          },
        },
        data: {
          concurrencyLimit: 4,
          concurrencyLimitOverriddenAt: overriddenAt,
          concurrencyLimitBase: 10,
        },
      });

      const result = await new ArchiveQueueService(prisma, engine).archive(
        environment,
        queue.friendlyId
      );
      expect(result.isOk()).toBe(true);

      const after = await prisma.taskQueue.findFirstOrThrow({
        where: { id: queue.id },
        include: { workers: { select: { id: true } } },
      });
      expect(after.archivedAt).not.toBeNull();
      expect(after.concurrencyLimit).toBe(4);
      expect(after.concurrencyLimitOverriddenAt).toEqual(overriddenAt);
      expect(after.concurrencyLimitBase).toBe(10);
      expect(after.paused).toBe(false);
      expect(after.workers.map((w) => w.id)).toEqual([worker.id]);
    }
  );

  containerTest("refuses to archive a queue with queued runs", async ({ prisma, redisOptions }) => {
    const engine = buildEngine(prisma, redisOptions);
    onTestFinished(() => engine.quit());
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await setupBackgroundWorker(engine, environment, "busy-task");
    await deployWithout(engine, environment);
    const queue = await prisma.taskQueue.findFirstOrThrow({
      where: { runtimeEnvironmentId: environment.id, name: "task/busy-task" },
    });
    await triggerOnQueue(engine, prisma, environment, "busy-task", queue.name);

    const result = await new ArchiveQueueService(prisma, engine).archive(
      environment,
      queue.friendlyId
    );
    expect(result.isErr() && result.error.type).toBe("queue_has_active_runs");

    const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
    expect(after.archivedAt).toBeNull();
  });

  containerTest(
    "counts runs handed to a worker queue but not yet picked up as active",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await setupBackgroundWorker(engine, environment, "handed-off-task");
      await deployWithout(engine, environment);
      const queue = await prisma.taskQueue.update({
        where: {
          runtimeEnvironmentId_name: {
            runtimeEnvironmentId: environment.id,
            name: "task/handed-off-task",
          },
        },
        data: { version: "V2" },
      });
      await triggerOnQueue(engine, prisma, environment, "handed-off-task", queue.name);

      // Move the run from the queue into the worker queue without a worker dequeuing it.
      await engine.runQueue.processMasterQueueForEnvironment(environment.id, 1);
      const [queued, running, inFlight] = await Promise.all([
        engine.lengthOfQueues(environment, [queue.name]),
        engine.currentConcurrencyOfQueues(environment, [queue.name]),
        engine.inFlightCountOfQueues(environment, [queue.name]),
      ]);
      expect(queued[queue.name]).toBe(0);
      expect(running[queue.name]).toBe(0);
      expect(inFlight[queue.name]).toBe(1);

      const service = new ArchiveQueueService(prisma, engine);
      const refused = await service.archive(environment, queue.friendlyId);
      expect(refused.isErr() && refused.error.type).toBe("queue_has_active_runs");

      // If it was archived before the hand-off, the safety net still surfaces it.
      await prisma.taskQueue.update({ where: { id: queue.id }, data: { archivedAt: new Date() } });
      const list = await new QueueListPresenter(25, prisma, prisma, engine).call({
        environment,
        page: 1,
        includeLimits: true,
        archived: "exclude",
        detectArchivedActivity: true,
      });
      expect(list.activeArchivedQueues?.map((q) => q.name)).toEqual(["handed-off-task"]);
    }
  );

  containerTest(
    "refuses to archive paused queues, limit-0 or combined-limit-0 queues and named concurrency limits",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const paused = await createQueue(prisma, environment, "paused", { paused: true });
      const zero = await createQueue(prisma, environment, "zero", { concurrencyLimit: 0 });
      const totalZero = await createQueue(prisma, environment, "total-zero", {
        totalConcurrencyLimit: 0,
      });
      const limit = await prisma.taskQueue.create({
        data: {
          friendlyId: generateFriendlyId("queue"),
          name: "limit/openai",
          role: "LIMIT",
          version: "V2",
          projectId: environment.project.id,
          runtimeEnvironmentId: environment.id,
        },
      });

      const service = new ArchiveQueueService(prisma, engine);
      const pausedResult = await service.archive(environment, paused.friendlyId);
      const zeroResult = await service.archive(environment, zero.friendlyId);
      const totalZeroResult = await service.archive(environment, totalZero.friendlyId);
      const limitResult = await service.archive(environment, limit.friendlyId);

      expect(pausedResult.isErr() && pausedResult.error.type).toBe("queue_paused");
      expect(zeroResult.isErr() && zeroResult.error.type).toBe("queue_limit_zero");
      expect(totalZeroResult.isErr() && totalZeroResult.error.type).toBe("queue_limit_zero");
      expect(limitResult.isErr() && limitResult.error.type).toBe("queue_not_found");

      const archivedCount = await prisma.taskQueue.count({
        where: { runtimeEnvironmentId: environment.id, archivedAt: { not: null } },
      });
      expect(archivedCount).toBe(0);
    }
  );

  containerTest(
    "check reports the reason and run count without archiving",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await setupBackgroundWorker(engine, environment, "checked-task");
      await deployWithout(engine, environment);
      const queue = await prisma.taskQueue.findFirstOrThrow({
        where: { runtimeEnvironmentId: environment.id, name: "task/checked-task" },
      });
      const service = new ArchiveQueueService(prisma, engine);

      const idle = await service.check(environment, queue.friendlyId);
      expect(idle.isOk() && idle.value).toBeUndefined();

      await triggerOnQueue(engine, prisma, environment, "checked-task", queue.name);
      await triggerOnQueue(engine, prisma, environment, "checked-task", queue.name);
      const busy = await service.check(environment, queue.friendlyId);
      expect(busy.isOk() && busy.value).toEqual({ type: "queue_has_active_runs", activeRuns: 2 });

      const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(after.archivedAt).toBeNull();
    }
  );

  containerTest(
    "refuses to archive a queue the current or an unpromoted deploy declares",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await setupBackgroundWorker(engine, environment, "live-task");
      const queue = await prisma.taskQueue.findFirstOrThrow({
        where: { runtimeEnvironmentId: environment.id, name: "task/live-task" },
      });
      const service = new ArchiveQueueService(prisma, engine);

      const live = await service.archive(environment, queue.friendlyId);
      expect(live.isErr() && live.error.type).toBe("queue_in_current_deployment");

      await deployWithout(engine, environment);
      const leftover = await service.check(environment, queue.friendlyId);
      expect(leftover.isOk() && leftover.value).toBeUndefined();

      // A newer deploy that declares the queue but isn't promoted yet still counts.
      await prisma.backgroundWorker.create({
        data: {
          friendlyId: generateFriendlyId("worker"),
          contentHash: "hash",
          projectId: environment.project.id,
          runtimeEnvironmentId: environment.id,
          version: "29990101.1",
          metadata: {},
          engine: "V2",
          queues: { connect: { id: queue.id } },
        },
      });
      const pending = await service.archive(environment, queue.friendlyId);
      expect(pending.isErr() && pending.error.type).toBe("queue_in_current_deployment");

      const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(after.archivedAt).toBeNull();
    }
  );

  containerTest(
    "a deploy created in the same millisecond as the current one still blocks archiving",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await setupBackgroundWorker(engine, environment, "tied-task");
      const queue = await prisma.taskQueue.findFirstOrThrow({
        where: { runtimeEnvironmentId: environment.id, name: "task/tied-task" },
      });
      const { worker: current } = await deployWithout(engine, environment);
      const { createdAt } = await prisma.backgroundWorker.findFirstOrThrow({
        where: { id: current.id },
        select: { createdAt: true },
      });

      await prisma.backgroundWorker.create({
        data: {
          friendlyId: generateFriendlyId("worker"),
          contentHash: "hash",
          projectId: environment.project.id,
          runtimeEnvironmentId: environment.id,
          version: "29990101.1",
          metadata: {},
          engine: "V2",
          createdAt,
          queues: { connect: { id: queue.id } },
        },
      });

      const service = new ArchiveQueueService(prisma, engine);
      const result = await service.archive(environment, queue.friendlyId);
      expect(result.isErr() && result.error.type).toBe("queue_in_current_deployment");
    }
  );

  containerTest(
    "a queue update landing between the check and the write aborts the archive",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const queue = await createQueue(prisma, environment, "racing");

      // Simulates a deploy re-declaring the queue while the activity check runs.
      const racingEngine = {
        lengthOfQueues: async (...args: Parameters<RunEngine["lengthOfQueues"]>) => {
          await prisma.taskQueue.update({
            where: { id: queue.id },
            data: { orderableName: "racing-redeclared" },
          });
          return engine.lengthOfQueues(...args);
        },
        currentConcurrencyOfQueues: engine.currentConcurrencyOfQueues.bind(engine),
        inFlightCountOfQueues: engine.inFlightCountOfQueues.bind(engine),
      };

      const result = await new ArchiveQueueService(prisma, racingEngine).archive(
        environment,
        queue.friendlyId
      );
      expect(result.isErr() && result.error.type).toBe("queue_changed");

      const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(after.archivedAt).toBeNull();
    }
  );

  containerTest(
    "unarchive brings the queue back to the default list",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const queue = await createQueue(prisma, environment, "returning", { archivedAt: new Date() });

      const result = await new ArchiveQueueService(prisma, engine).unarchive(
        environment,
        queue.friendlyId
      );
      expect(result.isOk()).toBe(true);

      const list = await new QueueListPresenter(25, prisma, prisma, engine).call({
        environment,
        page: 1,
        includeLimits: true,
        archived: "exclude",
        detectArchivedActivity: true,
      });
      expect(list.queues.map((q) => q.name)).toEqual(["returning"]);
    }
  );
});

describe("QueueListPresenter ranked sort", () => {
  containerTest(
    "a busy archived queue doesn't take a slot or push queues off the last page",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = buildEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "queue-archive-test",
      });
      onTestFinished(() => clickhouse.close());
      clickhouseRef.client = clickhouse;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // The busy queue sorts last by name, so name order (the error fallback) would fail this.
      for (const name of ["a", "b", "c", "d-busy"]) {
        await createQueue(prisma, environment, name);
      }
      await createQueue(prisma, environment, "z-archived", { archivedAt: new Date() });

      const eventTime = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace("T", " ");
      const gauge = (queue: string, queued: number) => ({
        organization_id: environment.organizationId,
        project_id: environment.projectId,
        environment_id: environment.id,
        queue_name: queue,
        event_time: eventTime,
        op: "gauge" as const,
        queued,
        running: 0,
      });
      const [insertError] = await clickhouse.queueMetrics.insertRaw(
        [gauge("d-busy", 5), gauge("z-archived", 50)],
        { params: { clickhouse_settings: { async_insert: 0 } } }
      );
      expect(insertError).toBeNull();

      const presenter = new QueueListPresenter(2, prisma, prisma, engine);
      const load = (page: number) =>
        presenter.call({
          environment,
          page,
          includeLimits: true,
          archived: "exclude",
          sort: "busiest",
        });

      const first = await load(1);
      const second = await load(2);
      expect(first.queues.map((q) => q.name)).toEqual(["d-busy", "a"]);
      expect(second.queues.map((q) => q.name)).toEqual(["b", "c"]);
      expect(first.pagination).toMatchObject({ totalPages: 2, count: 4 });
    }
  );
});
