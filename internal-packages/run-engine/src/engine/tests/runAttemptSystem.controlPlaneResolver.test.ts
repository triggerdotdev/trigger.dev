// Cross-DB inversion proof for runAttemptSystem.resolveTaskRunContext.
// run-ops scalars live on the run-ops DB (cross-seam FKs dropped); the env (slug/branchName/git/
// project/org) lives on the control-plane DB. resolveAuthenticatedEnv over the control-plane DB resolves the env half
// while PostgresRunStore over the run-ops DB resolves the run scalars — proving no cross-DB join.
// The DB is never mocked. A single-DB case drives the real resolveTaskRunContext end-to-end.
import { assertNonNullable, containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import {
  PassthroughControlPlaneResolver,
  type ControlPlaneResolver,
} from "../controlPlaneResolver.js";
import { ServiceValidationError } from "../errors.js";
import { PostgresRunStore } from "@internal/run-store";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngineOptions(redisOptions: any, prisma: any, overrides?: Record<string, unknown>) {
  return {
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    ...overrides,
  };
}

const TASK_RUN_CROSS_SEAM_FKS = [
  "TaskRun_runtimeEnvironmentId_fkey",
  "TaskRun_projectId_fkey",
  "TaskRun_organizationId_fkey",
] as const;

async function dropTaskRunCrossSeamFks(prisma: PrismaClient) {
  for (const constraint of TASK_RUN_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "${constraint}"`
    );
  }
}

async function seedRichEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      branchName: `feature-${suffix}`,
      git: { commitSha: `sha_${suffix}` },
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

describe("runAttemptSystem.resolveTaskRunContext controlPlaneResolver (hetero cross-DB)", () => {
  heteroPostgresTest(
    "env (slug/branchName/git) resolves from the control-plane DB while run scalars resolve from the run-ops DB (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedRichEnv(prisma14 as unknown as PrismaClient, "rtc");

      const runId = "run_rtc_runops";
      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: generateFriendlyId("run"),
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: "rtc-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/rtc-task",
          traceId: "trace_rtc",
          spanId: "span_rtc",
          workerQueue: "main",
        },
      });

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      // Run-ops scalars (incl. runtimeEnvironmentId, the resolver key) come from the run-ops DB.
      const run = await runStore.findRun(
        { id: runId },
        { select: { id: true, runtimeEnvironmentId: true, workerQueue: true } }
      );
      assertNonNullable(run);
      expect(run.id).toBe(runId);
      expect(run.runtimeEnvironmentId).toBe(cp.environment.id);

      // The env half — exactly the fields resolveTaskRunContext reads — comes from the control-plane DB.
      const env = await resolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      expect(env.id).toBe(cp.environment.id);
      expect(env.slug).toBe(cp.environment.slug);
      expect(env.type).toBe("PRODUCTION");
      expect(env.branchName).toBe(cp.environment.branchName);
      expect(env.organizationId).toBe(cp.organization.id);
      expect(env.git).toEqual({ commitSha: "sha_rtc" });

      // Proof of inversion: the run-ops DB holds no env rows; the control-plane DB holds no run rows.
      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );

  heteroPostgresTest(
    "startRunAttempt env resolves from the control-plane DB with run scalars on the run-ops DB (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedRichEnv(prisma14 as unknown as PrismaClient, "sra");

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const controlPlaneResolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      const runId = "run_sra_runops";
      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "DEQUEUED",
          attemptNumber: 0,
          friendlyId: generateFriendlyId("run"),
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: "sra-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/sra-task",
          traceId: "trace_sra",
          spanId: "span_sra",
          workerQueue: "main",
        },
      });

      // startAttempt reads run scalars from the run-ops DB and resolves env from the control-plane DB.
      const updatedRun = await runStore.startAttempt(
        runId,
        { attemptNumber: 1, executedAt: new Date(), isWarmStart: false },
        { select: { id: true, runtimeEnvironmentId: true, attemptNumber: true } },
        prisma17 as unknown as PrismaClient
      );
      const env = await controlPlaneResolver.resolveAuthenticatedEnv(
        updatedRun.runtimeEnvironmentId
      );
      assertNonNullable(env);
      expect(env.id).toBe(cp.environment.id);
      expect(env.git).toEqual({ commitSha: "sha_sra" });

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );

  heteroPostgresTest(
    "recordRetryOutcome run scalars resolve from the run-ops DB, env (org + project) from the control-plane DB (no cross-DB join, no orgMember)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedRichEnv(prisma14 as unknown as PrismaClient, "rro");

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const controlPlaneResolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      const runId = "run_rro_runops";
      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "DEQUEUED",
          attemptNumber: 1,
          friendlyId: generateFriendlyId("run"),
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: "rro-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/rro-task",
          traceId: "trace_rro",
          spanId: "span_rro",
          workerQueue: "main",
        },
      });

      const run = await runStore.recordRetryOutcome(
        runId,
        { machinePreset: "small-1x", usageDurationMs: 1, costInCents: 1 },
        { select: { id: true, runtimeEnvironmentId: true, status: true } },
        prisma17 as unknown as PrismaClient
      );
      const env = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      expect(env.organizationId).toBe(cp.organization.id);
      expect(env.project.id).toBe(cp.project.id);
      expect(env.id).toBe(cp.environment.id);

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );

  heteroPostgresTest(
    "failRunPermanently run scalars resolve from the run-ops DB, env ids from the control-plane DB via resolveEnv (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedRichEnv(prisma14 as unknown as PrismaClient, "frp");

      const controlPlaneResolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      // resolveEnv supplies the env half; the store supplies run scalars.
      const env = await controlPlaneResolver.resolveEnv(cp.environment.id);
      assertNonNullable(env);
      expect(env.id).toBe(cp.environment.id);
      expect(env.type).toBe("PRODUCTION");
      expect(env.organizationId).toBe(cp.organization.id);
      expect(env.projectId).toBe(cp.project.id);
      expect(env.project.id).toBe(cp.project.id);

      // The run-ops DB holds no env; the control-plane DB holds no run.
      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});

describe("runAttemptSystem.resolveTaskRunContext controlPlaneResolver (single-DB passthrough)", () => {
  containerTest(
    "default passthrough resolveTaskRunContext is byte-identical (env + git resolve end-to-end)",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const runId = "run_rtc_passthru";
        await prisma.taskRun.create({
          data: {
            id: runId,
            engine: "V2",
            status: "PENDING",
            friendlyId: generateFriendlyId("run"),
            runtimeEnvironmentId: environment.id,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            taskIdentifier: "rtc-task",
            payload: "{}",
            payloadType: "application/json",
            queue: "task/rtc-task",
            traceId: "trace_rtc2",
            spanId: "span_rtc2",
            workerQueue: "main",
          },
        });

        const context = await engine.runAttemptSystem.resolveTaskRunContext(runId);
        expect(context.environment.id).toBe(environment.id);
        expect(context.environment.slug).toBe(environment.slug);
        expect(context.environment.type).toBe("PRODUCTION");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "resolveTaskRunContext surfaces a clean 404 when the env has vanished (resolveAuthenticatedEnv null)",
    async ({ prisma, redisOptions }) => {
      // A deleted/vanished env must surface a clean 404 ServiceValidationError,
      // not a "Cannot read properties of null" crash. We inject a resolver whose
      // resolveAuthenticatedEnv returns null (the run row still exists on the
      // run-ops side), while every other method delegates to the real passthrough.
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const passthrough = new PassthroughControlPlaneResolver({
        prisma,
      });
      const resolver: ControlPlaneResolver = {
        resolveEnv: passthrough.resolveEnv.bind(passthrough),
        resolveWorkerVersion: passthrough.resolveWorkerVersion.bind(passthrough),
        assertEnvExists: passthrough.assertEnvExists.bind(passthrough),
        async resolveAuthenticatedEnv() {
          return null;
        },
      };

      const engine = new RunEngine(
        createEngineOptions(redisOptions, prisma, { controlPlaneResolver: resolver })
      );

      try {
        const runId = "run_rtc_nullenv";
        await prisma.taskRun.create({
          data: {
            id: runId,
            engine: "V2",
            status: "PENDING",
            friendlyId: generateFriendlyId("run"),
            runtimeEnvironmentId: environment.id,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            taskIdentifier: "rtc-task",
            payload: "{}",
            payloadType: "application/json",
            queue: "task/rtc-task",
            traceId: "trace_rtc_nullenv",
            spanId: "span_rtc_nullenv",
            workerQueue: "main",
          },
        });

        let caught: unknown;
        try {
          await engine.runAttemptSystem.resolveTaskRunContext(runId);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(ServiceValidationError);
        const validationError = caught as ServiceValidationError;
        expect(validationError.status).toBe(404);
        expect(validationError.message).toBe("Task run environment not found");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "default passthrough startRunAttempt resolves env + git into the execution payload",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const taskIdentifier = "sra-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_sra1",
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-sra",
            spanId: "s-sra",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_sra",
          workerQueue: "main",
        });
        assertNonNullable(dequeued[0]);

        const { execution } = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        expect(execution.environment.id).toBe(environment.id);
        expect(execution.environment.slug).toBe(environment.slug);
        expect(execution.environment.type).toBe("PRODUCTION");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "default passthrough completeAttemptSuccess acks against the resolved org and finishes the run",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const taskIdentifier = "cas-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_cas1",
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-cas",
            spanId: "s-cas",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_cas",
          workerQueue: "main",
        });
        assertNonNullable(dequeued[0]);

        const attemptResult = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            ok: true,
            id: run.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        expect(result.snapshot.executionStatus).toBe("FINISHED");
        expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.run.status).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "default passthrough cancelRun acks against the resolved org and reaches a cancelled snapshot",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const taskIdentifier = "cancel-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_cancel1",
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-cancel",
            spanId: "s-cancel",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        const result = await engine.cancelRun({
          runId: run.id,
          completedAt: new Date(),
          reason: "Cancelled by the user",
        });

        expect(result.snapshot.executionStatus).toBe("FINISHED");

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.run.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    }
  );
});
