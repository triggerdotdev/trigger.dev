// Split from triggerFailedTask.test.ts (the call() path) so CI's
// duration-based sharding can balance the container-heavy tests.
import { describe, expect } from "vitest";

import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { RunId, classifyKind, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { makeEngine, makeService } from "./triggerFailedTaskTestHelpers";

vi.setConfig?.({ testTimeout: 60_000 });

describe("TriggerFailedTaskService — failed run residency (call)", () => {
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
    "failed child of a NEW (run-ops id) parent mints run-ops id (call)",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "failed-residency-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const parentFriendlyId = RunId.toFriendlyId(generateRunOpsId());
      expect(classifyKind(parentFriendlyId)).toBe("runOpsId");
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

      expect(classifyKind(friendlyId!)).toBe("runOpsId");

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
});
