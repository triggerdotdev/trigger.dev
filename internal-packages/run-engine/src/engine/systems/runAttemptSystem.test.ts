import { assertNonNullable, containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";
import { setTimeout } from "node:timers/promises";

vi.setConfig({ testTimeout: 60_000 });

// A real PostgresRunStore subclass (NEVER a mock) that records which dedicated
// RunStore method each runId was routed through, so the lifecycle tests can prove
// the taskRun reads/writes land on the store and not on direct prisma.
class CountingRunStore extends PostgresRunStore {
  public readonly calls: Record<string, string[]> = {
    findRun: [],
    startAttempt: [],
    completeAttemptSuccess: [],
    recordRetryOutcome: [],
    requeueRun: [],
    cancelRun: [],
    failRunPermanently: [],
    recordBulkActionMembership: [],
  };

  private record(method: keyof CountingRunStore["calls"], runId: string) {
    this.calls[method].push(runId);
  }

  countFor(method: keyof CountingRunStore["calls"], runId: string): number {
    return this.calls[method].filter((id) => id === runId).length;
  }

  override async findRun(where: any, args?: any, client?: any): Promise<any> {
    if (where && typeof where.id === "string") {
      this.record("findRun", where.id);
    }
    // Preserve the 2-arg (where, client) overload where args is actually the client.
    return super.findRun(where, args, client);
  }

  override async startAttempt<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    args: { select: S },
    tx?: any
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    this.record("startAttempt", runId);
    return super.startAttempt(runId, data, args, tx);
  }

  override async completeAttemptSuccess<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: any,
    args: { select: S },
    tx?: any
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    this.record("completeAttemptSuccess", runId);
    return super.completeAttemptSuccess(runId, data, args, tx);
  }

  override async recordRetryOutcome<I extends Prisma.TaskRunInclude>(
    runId: string,
    data: { machinePreset?: string; usageDurationMs: number; costInCents: number },
    args: { include: I },
    tx?: any
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    this.record("recordRetryOutcome", runId);
    return super.recordRetryOutcome(runId, data, args, tx);
  }

  override async requeueRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: any
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    this.record("requeueRun", runId);
    return super.requeueRun(runId, args, tx);
  }

  override async cancelRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: any,
    args: { select: S },
    tx?: any
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    this.record("cancelRun", runId);
    return super.cancelRun(runId, data, args, tx);
  }

  override async failRunPermanently<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: any,
    args: { select: S },
    tx?: any
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    this.record("failRunPermanently", runId);
    return super.failRunPermanently(runId, data, args, tx);
  }

  override async recordBulkActionMembership(
    runId: string,
    bulkActionId: string,
    tx?: any
  ): Promise<void> {
    this.record("recordBulkActionMembership", runId);
    return super.recordBulkActionMembership(runId, bulkActionId, tx);
  }
}

function createEngineOptions(redisOptions: any, prisma: any, store: PostgresRunStore | undefined) {
  return {
    prisma,
    ...(store ? { store } : {}),
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
        "small-2x": {
          name: "small-2x" as const,
          cpu: 1,
          memory: 1,
          centsPerMs: 0.0002,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

async function triggerRun(
  engine: RunEngine,
  environment: any,
  prisma: any,
  taskIdentifier: string,
  overrides: Record<string, unknown> = {}
) {
  return engine.trigger(
    {
      number: 1,
      friendlyId: `run_${Math.random().toString(36).slice(2, 10)}`,
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t_${Math.random().toString(36).slice(2, 10)}`,
      spanId: `s_${Math.random().toString(36).slice(2, 10)}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
      ...overrides,
    },
    prisma
  );
}

async function dequeueOne(engine: RunEngine) {
  await setTimeout(500);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_consumer",
    workerQueue: "main",
  });
  return dequeued;
}

describe("runAttemptSystem routes through the RunStore", () => {
  // startRunAttempt routes the EXECUTING run write (and the minimal load
  // read) through the store, resolved by the owning run id.
  containerTest(
    "startRunAttempt routes the run write through the store",
    async ({ prisma, redisOptions }) => {
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, store));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(engine, environment, prisma, taskIdentifier);
        const dequeued = await dequeueOne(engine);
        expect(dequeued.length).toBe(1);

        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        expect(attemptResult.run.status).toBe("EXECUTING");
        expect(attemptResult.run.attemptNumber).toBe(1);

        const persisted = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(persisted.status).toBe("EXECUTING");
        expect(persisted.attemptNumber).toBe(1);

        expect(store.countFor("startAttempt", run.id)).toBeGreaterThanOrEqual(1);
        expect(store.countFor("findRun", run.id)).toBeGreaterThanOrEqual(1);
      } finally {
        await engine.quit();
      }
    }
  );

  // attemptSucceeded finalizes COMPLETED_SUCCESSFULLY through the store, with
  containerTest(
    "attemptSucceeded finalizes through the store",
    async ({ prisma, redisOptions }) => {
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, store));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(engine, environment, prisma, taskIdentifier);
        const dequeued = await dequeueOne(engine);
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        const result = await engine.completeRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            ok: true,
            id: dequeued[0].run.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(result.snapshot.executionStatus).toBe("FINISHED");

        const persisted = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(persisted.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(persisted.output).toBe(`{"foo":"bar"}`);

        const execData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(execData);
        expect(execData.snapshot.executionStatus).toBe("FINISHED");

        expect(store.countFor("completeAttemptSuccess", run.id)).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  // attemptFailed -> retry routes the retry update through recordRetryOutcome,
  // preserving the deep runtimeEnvironment.{project,organization,orgMember} include.
  containerTest(
    "attemptFailed retry routes through the store with the deep include preserved",
    async ({ prisma, redisOptions }) => {
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, store));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier, undefined, {
          outOfMemory: { machine: "small-2x" },
        });

        const run = await triggerRun(engine, environment, prisma, taskIdentifier);
        const dequeued = await dequeueOne(engine);
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        const result = await engine.completeRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            ok: false,
            id: dequeued[0].run.id,
            error: {
              type: "INTERNAL_ERROR" as const,
              code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE" as const,
              message: "Process exited with code -1 after signal SIGKILL.",
              stackTrace: "JavaScript heap out of memory",
            },
          },
        });

        expect(result.attemptStatus).toBe("RETRY_QUEUED");
        expect(result.snapshot.executionStatus).toBe("QUEUED");

        const execData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(execData);
        expect(execData.snapshot.executionStatus).toBe("QUEUED");

        const persisted = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(persisted.machinePreset).toBe("small-2x");

        expect(store.countFor("recordRetryOutcome", run.id)).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-client passthrough: a start->succeed round-trip on the DEFAULT
  containerTest("single-DB binds one client (passthrough)", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = new RunEngine(createEngineOptions(redisOptions, prisma, undefined));

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const run = await triggerRun(engine, environment, prisma, taskIdentifier);
      const dequeued = await dequeueOne(engine);
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });
      await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: true,
          id: dequeued[0].run.id,
          output: `{"ok":true}`,
          outputType: "application/json",
        },
      });

      const persisted = await prisma.taskRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { executionSnapshots: true },
      });
      expect(persisted.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(persisted.executionSnapshots.length).toBeGreaterThan(0);
      expect(persisted.executionSnapshots.some((s: any) => s.executionStatus === "FINISHED")).toBe(
        true
      );
    } finally {
      await engine.quit();
    }
  });

  // cancelRun routes the CANCELED update through the dedicated cancelRun method
  containerTest(
    "cancelRun routes the CANCELED update through the store",
    async ({ prisma, redisOptions }) => {
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, store));

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";
        await setupBackgroundWorker(engine, environment, [parentTask, childTask]);

        const parentRun = await triggerRun(engine, environment, prisma, parentTask);
        const parentDequeued = await dequeueOne(engine);
        await engine.startRunAttempt({
          runId: parentDequeued[0].run.id,
          snapshotId: parentDequeued[0].snapshot.id,
        });

        // The child carries the associatedWaitpoint (it resumes its parent). Cancelling
        // the still-queued child finishes it immediately and completes that waitpoint.
        const childRun = await triggerRun(engine, environment, prisma, childTask, {
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
        });

        const associatedWaitpoint = await prisma.waitpoint.findFirstOrThrow({
          where: { completedByTaskRunId: childRun.id },
        });
        expect(associatedWaitpoint.status).toBe("PENDING");

        const result = await engine.cancelRun({
          runId: childRun.id,
          completedAt: new Date(),
          reason: "Cancelled by the user",
        });
        expect(result.snapshot.executionStatus).toBe("FINISHED");

        const execData = await engine.getRunExecutionData({ runId: childRun.id });
        expect(execData?.run.status).toBe("CANCELED");

        expect(store.countFor("cancelRun", childRun.id)).toBe(1);

        // The associated waitpoint was completed via waitpointSystem (inherited).
        const completedWaitpoint = await prisma.waitpoint.findUniqueOrThrow({
          where: { id: associatedWaitpoint.id },
        });
        expect(completedWaitpoint.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // cancelRun child fan-out stays single-DB: cancelling a parent enqueues
  containerTest("cancelRun child fan-out stays single-DB", async ({ prisma, redisOptions }) => {
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = new RunEngine(createEngineOptions(redisOptions, prisma, store));

    try {
      const parentTask = "parent-task";
      const childTask = "child-task";
      await setupBackgroundWorker(engine, environment, [parentTask, childTask]);

      const parentRun = await triggerRun(engine, environment, prisma, parentTask);

      // Two real children in the subgraph. The parent is left un-started so the cancel
      // finishes it immediately and runs the fan-out synchronously (an executing parent
      // would defer the fan-out to attempt completion).
      const childIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const childRun = await triggerRun(engine, environment, prisma, childTask, {
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
        });
        childIds.push(childRun.id);
      }

      const enqueuedIds: string[] = [];
      const originalEnqueue = engine.worker.enqueue.bind(engine.worker);
      (engine.worker as any).enqueue = async (item: any) => {
        if (typeof item?.id === "string" && item.id.startsWith("cancelRun:")) {
          enqueuedIds.push(item.id);
        }
        return originalEnqueue(item);
      };

      await engine.cancelRun({
        runId: parentRun.id,
        completedAt: new Date(),
        reason: "Cancelled by the user",
      });

      for (const childId of childIds) {
        expect(enqueuedIds).toContain(`cancelRun:${childId}`);
      }

      expect(store.countFor("cancelRun", parentRun.id)).toBe(1);
      for (const childId of childIds) {
        expect(store.countFor("cancelRun", childId)).toBe(0);
      }
    } finally {
      await engine.quit();
    }
  });

  // Bulk-action push on an already-finished run routes through the dedicated
  containerTest(
    "bulk-action push on a finished run routes through recordBulkActionMembership",
    async ({ prisma, redisOptions }) => {
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, store));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await triggerRun(engine, environment, prisma, taskIdentifier);
        const dequeued = await dequeueOne(engine);
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            ok: true,
            id: dequeued[0].run.id,
            output: `{}`,
            outputType: "application/json",
          },
        });

        const bulkActionId = "bulk_action_1234";
        const result = await engine.cancelRun({
          runId: run.id,
          bulkActionId,
        });

        expect(result.alreadyFinished).toBe(true);
        expect(store.countFor("recordBulkActionMembership", run.id)).toBe(1);
        expect(store.countFor("cancelRun", run.id)).toBe(0);

        const persisted = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(persisted.bulkActionGroupIds).toContain(bulkActionId);
      } finally {
        await engine.quit();
      }
    }
  );
});

async function seedEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: { title: "Test Organization", slug: `org-${Math.random().toString(36).slice(2, 8)}` },
  });
  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: `proj-${Math.random().toString(36).slice(2, 8)}`,
      externalRef: "proj_1234",
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_dev_apikey",
      pkApiKey: "pk_dev_apikey",
      shortcode: "short_code",
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(p: {
  runId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: "run_friendly_1",
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: "trace_1",
      spanId: "span_1",
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

describe("runAttemptSystem store routing — cross-version (heterogeneous Postgres)", () => {
  // The attempt-lifecycle store methods this unit routes to (startAttempt ->
  // completeAttemptSuccess) land their TaskRun write + FINISHED snapshot on the dedicated
  // run-ops store, while a legacy/control-plane store over the same migrated schema is
  // untouched. Proves the run-ops store owns the attempt lifecycle cross-version.
  heteroPostgresTest(
    "attempt lifecycle lands on the dedicated run-ops store",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const { organization, project, environment } = await seedEnvironment(prisma17);

      const runId = "run_hetero_lifecycle_1";
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      const started = await newStore.startAttempt(
        runId,
        { attemptNumber: 1, executedAt: new Date(), isWarmStart: false },
        { select: { id: true, status: true, attemptNumber: true } }
      );
      expect(started.status).toBe("EXECUTING");
      expect(started.attemptNumber).toBe(1);

      const completed = await newStore.completeAttemptSuccess(
        runId,
        {
          completedAt: new Date(),
          output: '{"result":"ok"}',
          outputType: "application/json",
          usageDurationMs: 500,
          costInCents: 10,
          snapshot: {
            executionStatus: "FINISHED",
            description: "Task completed successfully",
            runStatus: "COMPLETED_SUCCESSFULLY",
            attemptNumber: 1,
            environmentId: environment.id,
            environmentType: "DEVELOPMENT",
            projectId: project.id,
            organizationId: organization.id,
          },
        },
        { select: { id: true, status: true, output: true } }
      );
      expect(completed.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(completed.output).toBe('{"result":"ok"}');

      // The row + FINISHED snapshot are on the dedicated run-ops DB, byte-well-formed.
      const onNew = await prisma17.taskRun.findUniqueOrThrow({
        where: { id: runId },
        include: { executionSnapshots: { where: { executionStatus: "FINISHED" } } },
      });
      expect(onNew.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(onNew.executionSnapshots).toHaveLength(1);
      expect(onNew.executionSnapshots[0]?.runStatus).toBe("COMPLETED_SUCCESSFULLY");

      // The legacy/control-plane DB never saw this run — the lifecycle resolved to the owning store.
      const onLegacy = await prisma14.taskRun.findUnique({ where: { id: runId } });
      expect(onLegacy).toBeNull();
    }
  );
});
