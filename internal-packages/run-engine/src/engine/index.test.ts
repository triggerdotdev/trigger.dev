import { expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { RunEngine } from "./index.js";
import { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import { trace } from "@opentelemetry/api";
import { AuthenticatedEnvironment } from "../shared/index.js";
import { generateFriendlyId, sanitizeQueueName } from "@trigger.dev/core/v3/apps";
import { CURRENT_DEPLOYMENT_LABEL } from "./consts.js";

describe("RunEngine", () => {
  containerTest(
    "Trigger a simple run",
    { timeout: 15_000 },
    async ({ postgresContainer, prisma, redisContainer }) => {
      //create environment
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
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

      try {
        const taskIdentifier = "test-task";

        //create background worker
        const backgroundWorker = await setupBackgroundWorker(
          prisma,
          authenticatedEnvironment,
          taskIdentifier
        );

        //trigger the run
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
            traceId: "t12345",
            spanId: "s12345",
            masterQueue: "main",
            queueName: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );
        expect(run).toBeDefined();
        expect(run.friendlyId).toBe("run_1234");

        //check it's actually in the db
        const runFromDb = await prisma.taskRun.findUnique({
          where: {
            friendlyId: "run_1234",
          },
        });
        expect(runFromDb).toBeDefined();
        expect(runFromDb?.id).toBe(run.id);

        const snapshot = await prisma.taskRunExecutionSnapshot.findFirst({
          where: {
            runId: run.id,
          },
          orderBy: {
            createdAt: "desc",
          },
        });
        expect(snapshot).toBeDefined();
        expect(snapshot?.executionStatus).toBe("QUEUED");

        //check the waitpoint is created
        const runWaitpoint = await prisma.waitpoint.findMany({
          where: {
            completedByTaskRunId: run.id,
          },
        });
        expect(runWaitpoint.length).toBe(1);
        expect(runWaitpoint[0].type).toBe("RUN");

        //check the queue length
        const queueLength = await engine.runQueue.lengthOfQueue(
          authenticatedEnvironment,
          run.queue
        );
        expect(queueLength).toBe(1);

        //concurrency before
        const envConcurrencyBefore = await engine.runQueue.currentConcurrencyOfEnvironment(
          authenticatedEnvironment
        );
        expect(envConcurrencyBefore).toBe(0);

        //dequeue the run
        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: run.masterQueue,
        });
        expect(dequeued?.action).toBe("START_RUN");

        if (dequeued?.action !== "START_RUN") {
          throw new Error("Expected action to be START_RUN");
        }

        expect(dequeued.payload.run.id).toBe(run.id);
        expect(dequeued.payload.run.attemptNumber).toBe(1);
        expect(dequeued.payload.execution.status).toBe("DEQUEUED_FOR_EXECUTION");

        const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
          authenticatedEnvironment
        );
        expect(envConcurrencyAfter).toBe(1);

        //create an attempt
        // const attemptResult = await engine.createRunAttempt({
        //   runId: dequeued!.payload.run.id,
        //   snapshotId: dequeued!.id,
        // });
        // expect(attemptResult.run.id).toBe(run.id);
        // expect(attemptResult.run.status).toBe("EXECUTING");
        // expect(attemptResult.attempt.status).toBe("EXECUTING");
        // expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        engine.quit();
      }
    }
  );

  //todo triggerAndWait

  //todo batchTriggerAndWait

  //todo checkpoints

  //todo heartbeats

  //todo failing a run

  //todo cancelling a run

  //todo expiring a run

  //todo delaying a run
});

async function setupAuthenticatedEnvironment(prisma: PrismaClient, type: RuntimeEnvironmentType) {
  // Your database setup logic here
  const org = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: "test-organization",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project",
      externalRef: "proj_1234",
      organizationId: org.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type,
      slug: "slug",
      projectId: project.id,
      organizationId: org.id,
      apiKey: "api_key",
      pkApiKey: "pk_api_key",
      shortcode: "short_code",
      maximumConcurrencyLimit: 10,
    },
  });

  return await prisma.runtimeEnvironment.findUniqueOrThrow({
    where: {
      id: environment.id,
    },
    include: {
      project: true,
      organization: true,
      orgMember: true,
    },
  });
}

async function setupBackgroundWorker(
  prisma: PrismaClient,
  environment: AuthenticatedEnvironment,
  taskIdentifier: string
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: "hash",
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      version: "20241015.1",
      metadata: {},
    },
  });

  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: generateFriendlyId("task"),
      slug: taskIdentifier,
      filePath: `/trigger/myTask.ts`,
      exportName: "myTask",
      workerId: worker.id,
      runtimeEnvironmentId: environment.id,
      projectId: environment.project.id,
    },
  });

  const queueName = sanitizeQueueName(`task/${taskIdentifier}`);
  const taskQueue = await prisma.taskQueue.create({
    data: {
      friendlyId: generateFriendlyId("queue"),
      name: queueName,
      concurrencyLimit: 10,
      runtimeEnvironmentId: worker.runtimeEnvironmentId,
      projectId: worker.projectId,
      type: "VIRTUAL",
    },
  });

  if (environment.type !== "DEVELOPMENT") {
    const deployment = await prisma.workerDeployment.create({
      data: {
        friendlyId: generateFriendlyId("deployment"),
        contentHash: worker.contentHash,
        version: worker.version,
        shortCode: "short_code",
        imageReference: `trigger/${environment.project.externalRef}:${worker.version}.${environment.slug}`,
        status: "DEPLOYED",
        projectId: environment.project.id,
        environmentId: environment.id,
        workerId: worker.id,
      },
    });

    const promotion = await prisma.workerDeploymentPromotion.create({
      data: {
        label: CURRENT_DEPLOYMENT_LABEL,
        deploymentId: deployment.id,
        environmentId: environment.id,
      },
    });

    return {
      worker,
      task,
      deployment,
      promotion,
    };
  }

  return {
    worker,
    task,
  };
}
