import { expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { RunEngine } from "./index.js";
import { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import { trace } from "@opentelemetry/api";

describe("RunEngine", () => {
  containerTest(
    "Trigger a simple run",
    { timeout: 15_000 },
    async ({ postgresContainer, prisma, redisContainer }) => {
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
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      //trigger the run
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_1234",
          environment: authenticatedEnvironment,
          taskIdentifier: "test-task",
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
      const queueLength = await engine.runQueue.lengthOfQueue(authenticatedEnvironment, run.queue);
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
      expect(dequeued?.runId).toBe(run.id);
      expect(dequeued?.executionStatus).toBe("DEQUEUED_FOR_EXECUTION");

      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyAfter).toBe(1);

      //create an attempt
      const attemptResult = await engine.createRunAttempt({
        runId: dequeued!.runId,
        snapshotId: dequeued!.id,
      });
      expect(attemptResult.run.id).toBe(run.id);
      expect(attemptResult.run.status).toBe("EXECUTING");
      expect(attemptResult.attempt.status).toBe("EXECUTING");
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");
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
