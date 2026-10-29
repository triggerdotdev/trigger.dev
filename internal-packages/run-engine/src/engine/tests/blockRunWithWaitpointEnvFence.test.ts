// Cross-org registration fence: expectedEnvironmentId scopes the snapshot read, so a foreign run
// 404s before any edge is written (route maps that ServiceValidationError(404) to a generic 404).
import {
  assertNonNullable,
  containerTestWithIsolatedRedis as containerTest,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { ServiceValidationError } from "../errors.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function buildEngine(prisma: any, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

describe("blockRunWithWaitpoint environment fence", () => {
  containerTest(
    "a run from another environment cannot establish an edge (404 before registerBlocks)",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        // Env A owns the run; env B is the authenticated caller with a valid waitpoint. They share a
        // project so the only difference is the environment the fence keys on.
        const envA = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const envB = await prisma.runtimeEnvironment.create({
          data: {
            type: "STAGING",
            slug: "slug-b",
            projectId: envA.project.id,
            organizationId: envA.organizationId,
            apiKey: "api_key_b",
            pkApiKey: "pk_api_key_b",
            shortcode: "short_code_b",
            maximumConcurrencyLimit: 10,
          },
        });
        await setupBackgroundWorker(engine, envA, "fence-task");

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_fence1",
            environment: envA,
            taskIdentifier: "fence-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_fence",
            spanId: "s_fence",
            workerQueue: "main",
            queue: "task/fence-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: envB.id,
          projectId: envA.project.id,
        });

        let thrown: unknown;
        try {
          await engine.blockRunWithWaitpoint({
            runId: run.id,
            waitpoints: [waitpoint.id],
            projectId: envA.project.id,
            organizationId: envA.organizationId,
            expectedEnvironmentId: envB.id,
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(ServiceValidationError);
        expect((thrown as ServiceValidationError).status).toBe(404);

        const foreignEdges = await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } });
        expect(foreignEdges).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the same run blocks normally when the authenticated environment matches (positive control)",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "fence-task");

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_fence2",
            environment: env,
            taskIdentifier: "fence-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_fence2",
            spanId: "s_fence2",
            workerQueue: "main",
            queue: "task/fence-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
        });

        const snapshot = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: [waitpoint.id],
          projectId: env.project.id,
          organizationId: env.organizationId,
          expectedEnvironmentId: env.id,
        });
        assertNonNullable(snapshot);

        const edges = await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } });
        expect(edges).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );
});
