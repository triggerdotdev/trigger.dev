import { describe, expect, assert } from "vitest";
import {
  AuthenticatedEnvironment,
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  StartedRedisContainer,
} from "@internal/testcontainers";
import { WorkerGroupTokenService } from "~/v3/services/worker/workerGroupTokenService.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";
import {
  PrismaClient,
  PrismaClientOrTransaction,
  RunEngineVersion,
  TaskRunStatus,
  WorkerInstanceGroupType,
} from "@trigger.dev/database";
import { HEADER_NAME } from "@trigger.dev/worker";
import { RunEngine } from "@internal/run-engine";
import { trace } from "@opentelemetry/api";
import { TriggerTaskService } from "~/v3/services/triggerTask.server";
import { env } from "~/env.server";

describe("worker", () => {
  const defaultInstanceName = "test_worker";

  describe("auth", { concurrent: true, timeout: 10000 }, () => {
    containerTest("should fail", async ({ prisma }) => {
      const { workerGroup, token } = await setupWorkerGroup({ prisma });
      expect(workerGroup.type).toBe(WorkerInstanceGroupType.MANAGED);

      const missingToken = new Request("https://example.com", {
        headers: {
          [HEADER_NAME.WORKER_INSTANCE_NAME]: defaultInstanceName,
        },
      });

      const badToken = new Request("https://example.com", {
        headers: {
          Authorization: `Bearer foo`,
          [HEADER_NAME.WORKER_INSTANCE_NAME]: defaultInstanceName,
        },
      });

      const emptyToken = new Request("https://example.com", {
        headers: {
          Authorization: `Bearer `,
          [HEADER_NAME.WORKER_INSTANCE_NAME]: defaultInstanceName,
        },
      });

      const missingInstanceName = new Request("https://example.com", {
        headers: {
          Authorization: `Bearer ${token.plaintext}`,
        },
      });

      const tokenService = new WorkerGroupTokenService({ prisma });
      expect(await tokenService.authenticate(missingToken)).toBeUndefined();
      expect(await tokenService.authenticate(badToken)).toBeUndefined();
      expect(await tokenService.authenticate(emptyToken)).toBeUndefined();
      expect(await tokenService.authenticate(missingInstanceName)).toBeUndefined();
    });

    containerTest("should succeed", async ({ prisma }) => {
      const { workerGroup, token } = await setupWorkerGroup({ prisma });
      expect(workerGroup.type).toBe(WorkerInstanceGroupType.MANAGED);

      const request = new Request("https://example.com", {
        headers: {
          Authorization: `Bearer ${token.plaintext}`,
          [HEADER_NAME.WORKER_INSTANCE_NAME]: defaultInstanceName,
          [HEADER_NAME.WORKER_MANAGED_SECRET]: env.MANAGED_WORKER_SECRET,
        },
      });

      const tokenService = new WorkerGroupTokenService({ prisma });
      const authentication = await tokenService.authenticate(request);

      expect(authentication).toBeDefined();
      expect(authentication?.workerGroupId).toBe(workerGroup.id);

      const identicalAuth = await tokenService.authenticate(request);
      expect(identicalAuth).toEqual(authentication);

      const secondInstanceName = "test_worker_2";
      const secondRequest = new Request("https://example.com", {
        headers: {
          Authorization: `Bearer ${token.plaintext}`,
          [HEADER_NAME.WORKER_INSTANCE_NAME]: secondInstanceName,
          [HEADER_NAME.WORKER_MANAGED_SECRET]: env.MANAGED_WORKER_SECRET,
        },
      });
      const secondAuth = await tokenService.authenticate(secondRequest);
      expect(secondAuth).toBeDefined();
      expect(secondAuth?.workerGroupId).toBe(workerGroup.id);
      expect(secondAuth?.workerInstanceId).not.toBe(authentication?.workerInstanceId);
    });
  });

  describe("trigger", { timeout: 10000 }, () => {
    containerTest("dequeue - unmanaged", async ({ prisma, redisContainer }) => {
      const taskIdentifier = "test-task";

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(
        prisma,
        "PRODUCTION",
        "V2"
      );

      const { deployment } = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      assert(deployment, "deployment should be defined");

      const engine = setupRunEngine(prisma, redisContainer);
      const triggerService = new TriggerTaskService({ prisma, engine });

      const { token, workerGroupService, workerGroup } = await setupWorkerGroup({
        prisma,
        engine,
        authenticatedEnvironment,
      });

      // Promote worker group to project default
      await workerGroupService.setDefaultWorkerGroupForProject({
        projectId: authenticatedEnvironment.projectId,
        workerGroupId: workerGroup.id,
      });

      const request = new Request("https://example.com", {
        headers: {
          Authorization: `Bearer ${token.plaintext}`,
          [HEADER_NAME.WORKER_INSTANCE_NAME]: defaultInstanceName,
          [HEADER_NAME.WORKER_DEPLOYMENT_ID]: deployment.id,
        },
      });

      try {
        const tokenService = new WorkerGroupTokenService({ prisma, engine });
        const authenticatedInstance = await tokenService.authenticate(request);

        assert(authenticatedInstance, "authenticatedInstance should be defined");
        expect(authenticatedInstance.type).toBe(WorkerInstanceGroupType.UNMANAGED);
        assert(
          authenticatedInstance.type === WorkerInstanceGroupType.UNMANAGED,
          "type should be unmanaged"
        );

        // Trigger
        const run = await triggerService.call(taskIdentifier, authenticatedEnvironment, {});
        assert(run, "run should be defined");

        // Check this is a V2 run
        expect(run.engine).toBe(RunEngineVersion.V2);

        const queueLengthBefore = await engine.runQueue.lengthOfQueue(
          authenticatedEnvironment,
          run.queue
        );
        expect(queueLengthBefore).toBe(1);

        const runBeforeDequeue = await prisma.taskRun.findUnique({
          where: {
            id: run.id,
          },
        });
        expect(runBeforeDequeue?.status).toBe(TaskRunStatus.PENDING);

        // Dequeue
        const dequeued = await authenticatedInstance.dequeue();
        expect(dequeued.length).toBe(1);
        expect(dequeued[0].run.id).toBe(run.id);
        expect(dequeued[0].run.attemptNumber).toBe(1);
      } finally {
        engine.quit();
      }
    });
  });
});

async function setupWorkerGroup({
  prisma,
  engine,
  authenticatedEnvironment,
}: {
  prisma: PrismaClientOrTransaction;
  engine?: RunEngine;
  authenticatedEnvironment?: AuthenticatedEnvironment;
}) {
  const workerGroupService = new WorkerGroupService({ prisma, engine });
  const { workerGroup, token } = await workerGroupService.createWorkerGroup({
    projectId: authenticatedEnvironment?.projectId,
    organizationId: authenticatedEnvironment?.organizationId,
  });

  return {
    workerGroupService,
    workerGroup,
    token,
  };
}

function setupRunEngine(prisma: PrismaClient, redisContainer: StartedRedisContainer) {
  return new RunEngine({
    prisma,
    redis: {
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
      password: redisContainer.getPassword(),
      enableAutoPipelining: true,
    },
    worker: {
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
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
    tracer: trace.getTracer("test", "0.0.0"),
  });
}
