import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import { NoopPendingVersionRunIdLookup } from "../services/pendingVersionLookup.js";
import { PostgresPendingVersionRunIdLookup } from "./postgresPendingVersionLookup.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngine(
  prisma: PrismaClient,
  redisOptions: any,
  overrides?: Record<string, unknown>
) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      processWorkerQueueDebounceMs: 50,
      masterQueueConsumersDisabled: true,
    },
    runLock: {
      redis: redisOptions,
    },
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
      baseCostInCents: 0.0001,
    },
    pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
    tracer: trace.getTracer("test", "0.0.0"),
    ...overrides,
  });
}

async function nameDeploymentWithExternalId(
  prisma: PrismaClient,
  workerId: string,
  externalId: string
) {
  return prisma.workerDeployment.update({
    where: { workerId },
    data: { externalId },
  });
}

describe("RunEngine external deployment parking", () => {
  containerTest(
    "parks a run whose external deployment id nothing holds, then releases it pinned when a deployment carrying that id lands",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const currentWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-abc",
            },
            parkedOnExternalDeploymentId: "commit-abc",
          },
          prisma
        );

        const parked = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        expect(parked.status).toBe("PENDING_VERSION");
        expect(parked.statusReason).toBe("EXTERNAL_DEPLOYMENT_PENDING");
        expect(parked.lockedToVersionId).toBeNull();
        expect((parked.annotations as Record<string, unknown>).externalDeploymentId).toBe(
          "commit-abc"
        );

        const targetWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await nameDeploymentWithExternalId(prisma, targetWorker.worker.id, "commit-abc");

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(targetWorker.worker.id);

        const released = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        expect(released.status).toBe("PENDING");
        expect(released.lockedToVersionId).toBe(targetWorker.worker.id);
        expect(released.taskVersion).toBe(targetWorker.worker.version);
        expect(released.lockedToVersionId).not.toBe(currentWorker.worker.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "an unrelated deployment landing does not release a run parked on a different id, but still releases runs parked for other reasons",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const pinnedRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-wanted",
            },
            parkedOnExternalDeploymentId: "commit-wanted",
          },
          prisma
        );

        const plainRun = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_1235",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1235",
            spanId: "s1235",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        expect((await prisma.taskRun.findFirstOrThrow({ where: { id: plainRun.id } })).status).toBe(
          "PENDING"
        );

        await prisma.taskRun.update({
          where: { id: plainRun.id },
          data: { status: "PENDING_VERSION", statusReason: "NO_WORKER" },
        });

        const otherWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await nameDeploymentWithExternalId(prisma, otherWorker.worker.id, "commit-unrelated");

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(otherWorker.worker.id);

        const stillParked = await prisma.taskRun.findFirstOrThrow({ where: { id: pinnedRun.id } });
        expect(stillParked.status).toBe("PENDING_VERSION");
        expect(stillParked.lockedToVersionId).toBeNull();

        const releasedPlain = await prisma.taskRun.findFirstOrThrow({
          where: { id: plainRun.id },
        });
        expect(releasedPlain.status).toBe("PENDING");
        expect(releasedPlain.lockedToVersionId).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "releases a run that reports an external deployment id but is parked for an unrelated reason",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-reported",
            },
          },
          prisma
        );

        await prisma.taskRun.update({
          where: { id: run.id },
          data: { status: "PENDING_VERSION", statusReason: "NO_WORKER" },
        });

        const worker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        const released = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(released.status).toBe("PENDING");
        expect(released.lockedToVersionId).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a no-id deployment landing drains ordinary parked runs past a backlog of id-parked ones, without looping",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, {
        queueRunsWaitingForWorkerBatchSize: 2,
      });

      try {
        const taskIdentifier = "test-task";

        for (let i = 0; i < 3; i++) {
          await engine.trigger(
            {
              number: i + 1,
              friendlyId: `run_124${i}`,
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: `t124${i}`,
              spanId: `s124${i}`,
              queue: `task/${taskIdentifier}`,
              isTest: false,
              tags: [],
              annotations: {
                triggerSource: "sdk",
                triggerAction: "trigger",
                rootTriggerSource: "sdk",
                externalDeploymentId: "commit-never-lands",
              },
              parkedOnExternalDeploymentId: "commit-never-lands",
            },
            prisma
          );
        }

        const plainRun = await engine.trigger(
          {
            number: 4,
            friendlyId: "run_1299",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1299",
            spanId: "s1299",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        await prisma.taskRun.update({
          where: { id: plainRun.id },
          data: { status: "PENDING_VERSION", statusReason: "NO_WORKER" },
        });

        const worker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );

        const scheduleSpy = vi.spyOn(
          engine.pendingVersionSystem,
          "scheduleResolvePendingVersionRuns"
        );

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        const releasedPlain = await prisma.taskRun.findFirstOrThrow({ where: { id: plainRun.id } });
        expect(releasedPlain.status).toBe("PENDING");

        const stillParked = await prisma.taskRun.findMany({
          where: { id: { not: plainRun.id }, runtimeEnvironmentId: authenticatedEnvironment.id },
          select: { status: true },
        });
        expect(stillParked.map((r) => r.status)).toEqual([
          "PENDING_VERSION",
          "PENDING_VERSION",
          "PENDING_VERSION",
        ]);

        expect(scheduleSpy).not.toHaveBeenCalled();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "pins to the highest deployed version holding the id, even when an older build of that id finalizes last",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-forced",
            },
            parkedOnExternalDeploymentId: "commit-forced",
          },
          prisma
        );

        const olderWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await prisma.backgroundWorker.update({
          where: { id: olderWorker.worker.id },
          data: { version: "20260807.9" },
        });
        await prisma.workerDeployment.update({
          where: { workerId: olderWorker.worker.id },
          data: {
            externalId: "commit-forced",
            version: "20260807.9",
            shortCode: "short_code_20260807.9",
          },
        });

        const newerWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await prisma.backgroundWorker.update({
          where: { id: newerWorker.worker.id },
          data: { version: "20260807.10" },
        });
        await prisma.workerDeployment.update({
          where: { workerId: newerWorker.worker.id },
          data: {
            externalId: "commit-forced",
            version: "20260807.10",
            shortCode: "short_code_20260807.10",
          },
        });

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(olderWorker.worker.id);

        const released = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        expect(released.status).toBe("PENDING");
        expect(released.lockedToVersionId).toBe(newerWorker.worker.id);
        expect(released.taskVersion).toBe("20260807.10");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the parking deadline is measured from the delay the caller asked for, not from creation",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        const delayUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const enqueueSpy = vi.spyOn((engine.pendingVersionSystem as any).$.worker, "enqueue");

        await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            delayUntil,
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-delayed",
            },
            parkedOnExternalDeploymentId: "commit-delayed",
          },
          prisma
        );

        const deadlineCall = enqueueSpy.mock.calls.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ([args]: any[]) => args?.job === "expireParkedExternalDeploymentRun"
        );

        assertNonNullable(deadlineCall);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const availableAt = (deadlineCall[0] as any).availableAt as Date;

        expect(availableAt.getTime()).toBeGreaterThan(delayUntil.getTime());
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a deployment carrying an external id arms a follow-up sweep even when it found candidates",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-lands",
            },
            parkedOnExternalDeploymentId: "commit-lands",
          },
          prisma
        );

        const worker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await nameDeploymentWithExternalId(prisma, worker.worker.id, "commit-lands");

        const scheduleSpy = vi.spyOn(
          engine.pendingVersionSystem,
          "scheduleResolvePendingVersionRuns"
        );

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        expect(scheduleSpy).toHaveBeenCalledTimes(1);
        expect(scheduleSpy.mock.calls[0]?.[1]?.attempt).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a run released while still delayed records a DELAYED snapshot and no longer reports as parked",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60 * 60 * 1000),
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-released",
            },
            parkedOnExternalDeploymentId: "commit-released",
          },
          prisma
        );

        const worker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await nameDeploymentWithExternalId(prisma, worker.worker.id, "commit-released");

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(worker.worker.id);

        const released = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(released.status).toBe("DELAYED");
        expect(released.lockedToVersionId).toBe(worker.worker.id);

        const afterRelease = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id },
          orderBy: { createdAt: "asc" },
          select: { executionStatus: true, runStatus: true },
        });

        expect(afterRelease.at(-1)?.runStatus).toBe("DELAYED");
        expect(afterRelease.at(-1)?.executionStatus).toBe("DELAYED");

        // A later debounce push must not re-label an already-released run as parked.
        await engine.delayedRunSystem.rescheduleDelayedRun({
          runId: run.id,
          delayUntil: new Date(Date.now() + 2 * 60 * 60 * 1000),
          tx: prisma,
        });

        const afterPush = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id },
          orderBy: { createdAt: "asc" },
          select: { executionStatus: true, runStatus: true },
        });

        expect(afterPush.at(-1)?.runStatus).toBe("DELAYED");
        expect(afterPush.at(-1)?.executionStatus).toBe("DELAYED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a debounce push on a parked run keeps the snapshot parked instead of reporting it delayed",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60 * 1000),
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-snapshot",
            },
            parkedOnExternalDeploymentId: "commit-snapshot",
          },
          prisma
        );

        await engine.delayedRunSystem.rescheduleDelayedRun({
          runId: run.id,
          delayUntil: new Date(Date.now() + 10 * 60 * 1000),
          tx: prisma,
        });

        const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id },
          orderBy: { createdAt: "asc" },
          select: { executionStatus: true, runStatus: true },
        });

        const latest = snapshots.at(-1);

        assertNonNullable(latest);
        expect(latest.runStatus).toBe("PENDING_VERSION");
        expect(latest.executionStatus).toBe("RUN_CREATED");

        const stillParked = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(stillParked.status).toBe("PENDING_VERSION");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the parking deadline re-arms instead of expiring a run whose delay was pushed past it",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60 * 1000),
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-pushed",
            },
            parkedOnExternalDeploymentId: "commit-pushed",
          },
          prisma
        );

        // Stand in for a debounce push: the run's delay moves out, but nothing re-arms the
        // deadline that was computed when the run was first parked.
        const pushedDelayUntil = new Date(Date.now() + 60 * 60 * 1000);
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { delayUntil: pushedDelayUntil },
        });

        await engine.pendingVersionSystem.expireParkedExternalDeploymentRun({
          runId: run.id,
          externalDeploymentId: "commit-pushed",
        });

        const stillParked = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        expect(stillParked.status).toBe("PENDING_VERSION");
        expect(stillParked.statusReason).toBe("EXTERNAL_DEPLOYMENT_PENDING");
        expect(stillParked.expiredAt).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the parking deadline expires a run whose deployment never arrived",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-never",
            },
            parkedOnExternalDeploymentId: "commit-never",
          },
          prisma
        );

        await engine.pendingVersionSystem.expireParkedExternalDeploymentRun({
          runId: run.id,
          externalDeploymentId: "commit-never",
        });

        const expired = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        expect(expired.status).toBe("EXPIRED");
        expect(expired.statusReason).toBe("EXTERNAL_DEPLOYMENT_NOT_FOUND");
        expect(expired.expiredAt).not.toBeNull();
        expect(JSON.stringify(expired.error)).toContain("commit-never");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the parking deadline re-checks Postgres and releases instead of expiring when the deployment did land",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, {
        pendingVersionRunIdLookup: new NoopPendingVersionRunIdLookup(),
      });

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-late",
            },
            parkedOnExternalDeploymentId: "commit-late",
          },
          prisma
        );

        const targetWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await nameDeploymentWithExternalId(prisma, targetWorker.worker.id, "commit-late");

        await engine.pendingVersionSystem.expireParkedExternalDeploymentRun({
          runId: run.id,
          externalDeploymentId: "commit-late",
        });

        const released = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        expect(released.status).toBe("PENDING");
        expect(released.lockedToVersionId).toBe(targetWorker.worker.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the deadline is a no-op once the run has left PENDING_VERSION",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-raced",
            },
            parkedOnExternalDeploymentId: "commit-raced",
          },
          prisma
        );

        await prisma.taskRun.update({
          where: { id: run.id },
          data: { status: "PENDING" },
        });

        await engine.pendingVersionSystem.expireParkedExternalDeploymentRun({
          runId: run.id,
          externalDeploymentId: "commit-raced",
        });

        const untouched = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(untouched.status).toBe("PENDING");
        expect(untouched.expiredAt).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a parked run keeps the delay its caller asked for, and re-delays rather than jumping the queue",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        const delayUntil = new Date(Date.now() + 60 * 60 * 1000);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1234",
            spanId: "s1234",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            delayUntil,
            annotations: {
              triggerSource: "sdk",
              triggerAction: "trigger",
              rootTriggerSource: "sdk",
              externalDeploymentId: "commit-delayed",
            },
            parkedOnExternalDeploymentId: "commit-delayed",
          },
          prisma
        );

        const parked = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(parked.status).toBe("PENDING_VERSION");
        assertNonNullable(parked.delayUntil);

        const targetWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );
        await nameDeploymentWithExternalId(prisma, targetWorker.worker.id, "commit-delayed");

        await engine.pendingVersionSystem.enqueueRunsForBackgroundWorker(targetWorker.worker.id);

        const released = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        expect(released.status).toBe("DELAYED");
        expect(released.lockedToVersionId).toBe(targetWorker.worker.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a debounced run that parks still collapses later triggers for the same key",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "debounced-parked-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const debounce = { key: "digest-user-1", delay: "5m" };
        const delayUntil = new Date(Date.now() + 5 * 60 * 1000);

        const triggerOnce = (number: number) =>
          engine.trigger(
            {
              number,
              friendlyId: `run_123${number}`,
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: `t_debounce_${number}`,
              spanId: `s_debounce_${number}`,
              queue: `task/${taskIdentifier}`,
              isTest: false,
              tags: [],
              annotations: {
                triggerSource: "sdk",
                triggerAction: "trigger",
                rootTriggerSource: "sdk",
                externalDeploymentId: "commit-abc",
              },
              delayUntil,
              debounce,
              parkedOnExternalDeploymentId: "commit-abc",
            },
            prisma
          );

        const first = await triggerOnce(1);
        const second = await triggerOnce(2);
        const third = await triggerOnce(3);

        expect(second.id).toBe(first.id);
        expect(third.id).toBe(first.id);

        const runs = await prisma.taskRun.findMany({
          where: { runtimeEnvironmentId: authenticatedEnvironment.id, taskIdentifier },
        });

        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe("PENDING_VERSION");
      } finally {
        await engine.quit();
      }
    }
  );
});
