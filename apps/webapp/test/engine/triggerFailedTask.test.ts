import { describe, expect } from "vitest";

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { RunId, classifyKind, generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { TriggerFailedTaskService } from "../../app/runEngine/services/triggerFailedTask.server";
import { EventRepository } from "../../app/v3/eventRepository/eventRepository.server";

vi.setConfig?.({ testTimeout: 60_000 });

// Bind the service's trace-event writes to the testcontainer DB. Without this,
// call() resolves the repository via getEventRepository → global prisma, which
// points at a database that doesn't exist in CI.
function makeService(prisma: any, engine: RunEngine) {
  return new TriggerFailedTaskService({
    prisma,
    engine,
    // Read the parent through the same store the engine wrote it to.
    runStore: engine.runStore,
    eventRepository: {
      repository: new EventRepository(prisma, prisma, {
        batchSize: 100,
        batchInterval: 1000,
        retentionInDays: 30,
        partitioningEnabled: false,
      }),
      store: "taskEvent",
    },
  });
}

function makeEngine(prisma: any, redisOptions: any) {
  return new RunEngine({
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
}

describe("TriggerFailedTaskService — failed run residency", () => {
  containerTest(
    "root failed run mints cuid when split is off (call)",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "failed-residency-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const service = makeService(prisma, engine);

      const friendlyId = await service.call({
        taskId: taskIdentifier,
        environment,
        payload: { test: "root" },
        errorMessage: "boom",
      });

      expect(friendlyId).toBeTruthy();
      expect(classifyKind(friendlyId!)).toBe("cuid");

      // The failed run write must land (persistence) with no parent linkage.
      const persisted = await prisma.taskRun.findFirst({ where: { friendlyId: friendlyId! } });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe("SYSTEM_FAILURE");
      expect(persisted!.depth).toBe(0);
      expect(persisted!.parentTaskRunId).toBeNull();

      await engine.quit();
    }
  );

  containerTest(
    "failed child of a NEW (ksuid) parent mints ksuid (call)",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "failed-residency-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const parentFriendlyId = RunId.toFriendlyId(generateKsuidId());
      expect(classifyKind(parentFriendlyId)).toBe("ksuid");
      await engine.trigger(
        {
          friendlyId: parentFriendlyId,
          environment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          traceId: "00000000000000000000000000000000",
          spanId: "0000000000000000",
          workerQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        } as any,
        prisma
      );

      const service = makeService(prisma, engine);

      const friendlyId = await service.call({
        taskId: taskIdentifier,
        environment,
        payload: { test: "child" },
        errorMessage: "boom",
        parentRunId: parentFriendlyId,
      });

      expect(classifyKind(friendlyId!)).toBe("ksuid");

      // The failed run write must land (persistence) and link to the resolved parent.
      const persisted = await prisma.taskRun.findFirst({ where: { friendlyId: friendlyId! } });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe("SYSTEM_FAILURE");

      const parent = await prisma.taskRun.findFirst({ where: { friendlyId: parentFriendlyId } });
      expect(persisted!.parentTaskRunId).toBe(parent!.id);
      expect(persisted!.depth).toBe(parent!.depth + 1);
      expect(persisted!.rootTaskRunId).toBe(parent!.rootTaskRunId ?? parent!.id);

      await engine.quit();
    }
  );

  containerTest(
    "failed child of a LEGACY (cuid) parent mints cuid (call)",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "failed-residency-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const parentFriendlyId = RunId.generate().friendlyId; // cuid → LEGACY
      expect(classifyKind(parentFriendlyId)).toBe("cuid");
      await engine.trigger(
        {
          friendlyId: parentFriendlyId,
          environment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          traceId: "00000000000000000000000000000000",
          spanId: "0000000000000000",
          workerQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        } as any,
        prisma
      );

      const service = makeService(prisma, engine);

      const friendlyId = await service.call({
        taskId: taskIdentifier,
        environment,
        payload: { test: "child" },
        errorMessage: "boom",
        parentRunId: parentFriendlyId,
      });

      expect(classifyKind(friendlyId!)).toBe("cuid");

      await engine.quit();
    }
  );

  containerTest(
    "failed child of a NEW parent mints ksuid (callWithoutTraceEvents)",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "failed-residency-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const parentFriendlyId = RunId.toFriendlyId(generateKsuidId());
      await engine.trigger(
        {
          friendlyId: parentFriendlyId,
          environment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          traceId: "00000000000000000000000000000000",
          spanId: "0000000000000000",
          workerQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        } as any,
        prisma
      );

      const service = makeService(prisma, engine);

      const friendlyId = await service.callWithoutTraceEvents({
        environmentId: environment.id,
        environmentType: environment.type,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
        taskId: taskIdentifier,
        payload: { test: "child" },
        errorMessage: "boom",
        parentRunId: parentFriendlyId,
      });

      expect(classifyKind(friendlyId!)).toBe("ksuid");

      await engine.quit();
    }
  );

  containerTest(
    "callWithoutTraceEvents returns null (best-effort) when the derived parent row is absent",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "failed-residency-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const service = makeService(prisma, engine);

      // A well-formed ksuid parent friendlyId that was NEVER triggered → no row.
      // Exercises the missing-parent fallback in callWithoutTraceEvents.
      const absentParentFriendlyId = RunId.toFriendlyId(generateKsuidId());

      const friendlyId = await service.callWithoutTraceEvents({
        environmentId: environment.id,
        environmentType: environment.type,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
        taskId: taskIdentifier,
        payload: { test: "absent-parent" },
        errorMessage: "boom",
        parentRunId: absentParentFriendlyId,
      });

      // Fallback derives parentTaskRunId from an id with no row; the parentTaskRunId FK rejects the create, so the method returns null instead of throwing.
      expect(friendlyId).toBeNull();
      const orphan = await prisma.taskRun.findFirst({
        where: { parentTaskRunId: RunId.fromFriendlyId(absentParentFriendlyId) },
      });
      expect(orphan).toBeNull();

      await engine.quit();
    }
  );
});
