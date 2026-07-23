// Split from triggerFailedTask.test.ts (the callWithoutTraceEvents() path) so
// CI's duration-based sharding can balance the container-heavy tests.
import { describe, expect } from "vitest";

import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { RunId, classifyKind, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { makeEngine, makeService } from "./triggerFailedTaskTestHelpers";

vi.setConfig?.({ testTimeout: 60_000 });

describe("TriggerFailedTaskService — failed run residency (callWithoutTraceEvents)", () => {
  containerTest(
    "failed child of a NEW parent mints run-ops id (callWithoutTraceEvents)",
    async ({ prisma, redisOptions }) => {
      const engine = makeEngine(prisma, redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "failed-residency-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const parentFriendlyId = RunId.toFriendlyId(generateRunOpsId());
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

      expect(classifyKind(friendlyId!)).toBe("runOpsId");

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

      // A well-formed run-ops parent friendlyId that was NEVER triggered → no row.
      // Exercises the missing-parent fallback in callWithoutTraceEvents.
      const absentParentFriendlyId = RunId.toFriendlyId(generateRunOpsId());

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
