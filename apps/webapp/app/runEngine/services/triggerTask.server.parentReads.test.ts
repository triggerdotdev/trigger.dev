// Split from triggerTask.server.test.ts (parent-read concerns) so CI's
// duration-based sharding can balance the container-heavy tests.
import { describe, expect, vi } from "vitest";

// Mock the db prisma client. The service is constructed against a real
// testcontainer prisma instead — these empty singletons only satisfy the
// module-level imports of the production wiring (infrastructure boundary).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));
// Inherited harness boilerplate. The parent read under test takes the
// findRun(where, client) overload with this.prisma, so it does not consult this
// flag; the mock only satisfies other wiring imported transitively.
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
import { trace } from "@opentelemetry/api";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "./triggerTask.server";
import {
  buildEngine,
  CapturingParentRunValidator,
  MockPayloadProcessor,
  MockTraceEventConcern,
} from "./triggerTask.server.test.helpers";

vi.setConfig({ testTimeout: 60_000 }); // 60 seconds timeout

describe("RunEngineTriggerTaskService parent reads", () => {
  containerTest(
    "resolves the parent run through the run-ops store by minted run id",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const validator = new CapturingParentRunValidator();
        const triggerTaskService = new RunEngineTriggerTaskService({
          engine,
          prisma,
          payloadProcessor: new MockPayloadProcessor(),
          queueConcern: new DefaultQueueManager(prisma, engine),
          idempotencyKeyConcern: new IdempotencyKeyConcern(
            prisma,
            engine,
            new MockTraceEventConcern()
          ),
          validator,
          traceEventConcern: new MockTraceEventConcern(),
          tracer: trace.getTracer("test", "0.0.0"),
          metadataMaximumSize: 1024 * 1024 * 1,
        });

        // Trigger a ROOT run first to create a real parent TaskRun.
        const parentResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment,
          body: { payload: { kind: "parent" } },
        });
        assertNonNullable(parentResult);

        // Trigger a CHILD pointing at the parent's friendlyId. The service must
        // resolve the parent via runStore.findRun (minted RunId, env-scoped).
        const childResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment,
          body: {
            payload: { kind: "child" },
            options: { parentRunId: parentResult.run.friendlyId },
          },
        });
        assertNonNullable(childResult);

        // The capturing validator observed the resolved parent — proving the
        // read ran (against the container DB) and returned the right row.
        expect(validator.capturedParentRun).not.toBe("unset");
        const capturedParent = validator.capturedParentRun;
        assertNonNullable(capturedParent);
        expect(capturedParent.id).toBe(parentResult.run.id);
        expect(capturedParent.friendlyId).toBe(parentResult.run.friendlyId);

        // depth and root carry through — proving parentRun.depth and the parent
        // id were read off the resolved row and threaded into the child.
        const parentRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: parentResult.run.id },
        });
        const childRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: childResult.run.id },
        });

        expect(childRow.depth).toBe(parentRow.depth + 1);
        expect(childRow.parentTaskRunId).toBe(parentRow.id);
        expect(childRow.rootTaskRunId).toBe(parentRow.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "scopes the parent lookup to the run's environment (cross-env parent is not resolved)",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        // Two independent authenticated environments. The setup helper hardcodes
        // several globally-unique fields (org/project slug, env apiKey/pkApiKey,
        // worker-group token hash), so rename envA's before the second call to
        // avoid unique-constraint collisions.
        const envA = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: envA.organizationId },
          data: { slug: `${envA.organization.slug}-a` },
        });
        await prisma.project.update({
          where: { id: envA.projectId },
          data: { slug: `${envA.project.slug}-a`, externalRef: `${envA.project.externalRef}-a` },
        });
        await prisma.runtimeEnvironment.update({
          where: { id: envA.id },
          data: { apiKey: `${envA.apiKey}-a`, pkApiKey: `${envA.pkApiKey}-a` },
        });
        await prisma.workerGroupToken.updateMany({
          where: { tokenHash: "token_hash" },
          data: { tokenHash: "token_hash_a" },
        });
        await prisma.workerInstanceGroup.updateMany({
          where: { masterQueue: "default" },
          data: { masterQueue: "default_a" },
        });
        const envB = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        expect(envA.id).not.toBe(envB.id);
        expect(envA.organizationId).not.toBe(envB.organizationId);

        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, envA, taskIdentifier);
        await setupBackgroundWorker(engine, envB, taskIdentifier);

        const validator = new CapturingParentRunValidator();
        const triggerTaskService = new RunEngineTriggerTaskService({
          engine,
          prisma,
          payloadProcessor: new MockPayloadProcessor(),
          queueConcern: new DefaultQueueManager(prisma, engine),
          idempotencyKeyConcern: new IdempotencyKeyConcern(
            prisma,
            engine,
            new MockTraceEventConcern()
          ),
          validator,
          traceEventConcern: new MockTraceEventConcern(),
          tracer: trace.getTracer("test", "0.0.0"),
          metadataMaximumSize: 1024 * 1024 * 1,
        });

        // A real parent run in envA.
        const parentResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment: envA,
          body: { payload: { kind: "parent" } },
        });
        assertNonNullable(parentResult);

        // Trigger a child in envB pointing at the envA parent's friendlyId. The
        // env guard in runStore.findRun's `where` rejects the cross-env parent
        // in a single query, so the resolved parentRun is null.
        const childResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment: envB,
          body: {
            payload: { kind: "child" },
            options: { parentRunId: parentResult.run.friendlyId },
          },
        });
        assertNonNullable(childResult);

        // validateParentRun was called with no resolved parent.
        expect(validator.capturedParentRun).not.toBe("unset");
        expect(validator.capturedParentRun ?? null).toBeNull();

        // The child still triggered, at the root depth with no parent linkage —
        // confirming the cross-env parent was dropped, not silently joined.
        const childRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: childResult.run.id },
        });
        expect(childRow.depth).toBe(0);
        expect(childRow.parentTaskRunId).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("a root trigger issues no parent lookup", async ({ prisma, redisOptions }) => {
    const engine = buildEngine(prisma, redisOptions);

    try {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const validator = new CapturingParentRunValidator();
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern: new IdempotencyKeyConcern(
          prisma,
          engine,
          new MockTraceEventConcern()
        ),
        validator,
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1,
      });

      // Trigger with NO parentRunId.
      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { kind: "root" } },
      });
      assertNonNullable(result);

      // The validator ran but received no resolved parent: the parent read was
      // skipped because no parentRunId was supplied.
      expect(validator.capturedParentRun).not.toBe("unset");
      expect(validator.capturedParentRun).toBeUndefined();

      const runRow = await prisma.taskRun.findUniqueOrThrow({
        where: { id: result.run.id },
      });
      expect(runRow.depth).toBe(0);
      expect(runRow.parentTaskRunId).toBeNull();
    } finally {
      await engine.quit();
    }
  });
});
