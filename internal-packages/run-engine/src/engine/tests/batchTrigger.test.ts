import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { generateFriendlyId } from "@trigger.dev/core/v3/apps";
import { expect } from "vitest";
import { RunEngine } from "../index.js";

describe("RunEngine batchTrigger", () => {
  containerTest(
    "Batch trigger shares a batch",
    { timeout: 15_000 },
    async ({ prisma, redisContainer }) => {
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
          baseCostInCents: 0.0005,
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

        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: generateFriendlyId("batch"),
            runtimeEnvironmentId: authenticatedEnvironment.id,
          },
        });

        //trigger the runs
        const run1 = await engine.trigger(
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
            batchId: batch.id,
          },
          prisma
        );

        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_1235",
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
            batchId: batch.id,
          },
          prisma
        );

        expect(run1).toBeDefined();
        expect(run1.friendlyId).toBe("run_1234");
        expect(run1.batchId).toBe(batch.id);

        expect(run2).toBeDefined();
        expect(run2.friendlyId).toBe("run_1235");
        expect(run2.batchId).toBe(batch.id);

        //check the queue length
        const queueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(queueLength).toBe(2);
      } finally {
        engine.quit();
      }
    }
  );
});
