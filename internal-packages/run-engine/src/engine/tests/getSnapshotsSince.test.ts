import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect, describe } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { setTimeout } from "node:timers/promises";
import {
  generateTestScenarios,
  type SnapshotTestScenario,
} from "./helpers/executionStateMachine.js";
import {
  createWaitpointsWithOutput,
  setupTestScenario,
  generateLargeOutput,
} from "./helpers/snapshotTestHelpers.js";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";

vi.setConfig({ testTimeout: 120_000 });

describe("RunEngine getSnapshotsSince", () => {
  containerTest(
    "returns empty array when querying from latest snapshot",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const runFriendlyId = generateFriendlyId("run");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: runFriendlyId,
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_empty",
            spanId: "s_empty",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_empty",
          workerQueue: "main",
        });

        // Get all snapshots
        const allSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "asc" },
        });

        expect(allSnapshots.length).toBeGreaterThan(0);

        // Query from the last snapshot
        const lastSnapshot = allSnapshots[allSnapshots.length - 1];
        const result = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: lastSnapshot.id,
        });

        expect(result).not.toBeNull();
        expect(result!.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "returns snapshots after the specified one with waitpoints only on latest",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const runFriendlyId = generateFriendlyId("run");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: runFriendlyId,
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_wp",
            spanId: "s_wp",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_wp",
          workerQueue: "main",
        });

        // Start attempt
        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // Create and block with a waitpoint
        const { waitpoint } = await engine.createDateTimeWaitpoint({
          projectId: authenticatedEnvironment.project.id,
          environmentId: authenticatedEnvironment.id,
          completedAfter: new Date(Date.now() + 50),
        });

        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: [waitpoint.id],
          projectId: authenticatedEnvironment.project.id,
          organizationId: authenticatedEnvironment.organization.id,
        });

        // Wait for waitpoint completion
        await setTimeout(200);

        // Get all snapshots
        const allSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "asc" },
        });

        expect(allSnapshots.length).toBeGreaterThanOrEqual(3);

        // Query from the first snapshot
        const result = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: allSnapshots[0].id,
        });

        expect(result).not.toBeNull();
        expect(result!.length).toBeGreaterThanOrEqual(2);

        // The latest snapshot should have completedWaitpoints
        const latest = result![result!.length - 1];
        expect(latest.completedWaitpoints.length).toBeGreaterThan(0);

        // Earlier snapshots should have empty waitpoints (optimization)
        for (let i = 0; i < result!.length - 1; i++) {
          expect(result![i].completedWaitpoints.length).toBe(0);
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "handles multiple waitpoints correctly - only latest has them",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const runFriendlyId = generateFriendlyId("run");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: runFriendlyId,
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_mwp",
            spanId: "s_mwp",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_mwp",
          workerQueue: "main",
        });

        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // Create multiple waitpoints
        const waitpointCount = 5;
        const waitpointPromises = Array.from({ length: waitpointCount }).map(() =>
          engine.createManualWaitpoint({
            environmentId: authenticatedEnvironment.id,
            projectId: authenticatedEnvironment.projectId,
          })
        );
        const waitpoints = await Promise.all(waitpointPromises);

        // Block the run with all waitpoints
        for (const { waitpoint } of waitpoints) {
          await engine.blockRunWithWaitpoint({
            runId: run.id,
            waitpoints: waitpoint.id,
            projectId: authenticatedEnvironment.projectId,
            organizationId: authenticatedEnvironment.organizationId,
          });
        }

        // Complete all waitpoints
        for (const { waitpoint } of waitpoints) {
          await engine.completeWaitpoint({ id: waitpoint.id });
        }

        await setTimeout(500);

        // Get all snapshots
        const allSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "asc" },
        });

        // Query from early in the sequence
        const result = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: allSnapshots[0].id,
        });

        expect(result).not.toBeNull();
        expect(result!.length).toBeGreaterThan(0);

        // Only the latest should have waitpoints
        const latest = result![result!.length - 1];

        // Earlier snapshots must have empty completedWaitpoints
        for (let i = 0; i < result!.length - 1; i++) {
          expect(result![i].completedWaitpoints.length).toBe(0);
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("returns null for invalid snapshot ID", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      worker: {
        redis: redisOptions,
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 100,
      },
      queue: {
        redis: redisOptions,
      },
      runLock: {
        redis: redisOptions,
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
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const runFriendlyId = generateFriendlyId("run");
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: runFriendlyId,
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t_invalid",
          spanId: "s_invalid",
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      // Query with invalid snapshot ID
      const result = await engine.getSnapshotsSince({
        runId: run.id,
        snapshotId: "invalid-snapshot-id",
      });

      // Should return null (caught by getSnapshotsSince error handler)
      expect(result).toBeNull();
    } finally {
      await engine.quit();
    }
  });

  // Direct database tests for the core function
  containerTest(
    "direct test: large waitpoint scenario - 100 waitpoints with 10KB outputs",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
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
        // Create scenario directly in database
        const scenario = await setupTestScenario(prisma, authenticatedEnvironment, {
          totalWaitpoints: 100,
          outputSizeKB: 10,
          snapshotConfigs: [
            { status: "RUN_CREATED", completedWaitpointCount: 0 },
            { status: "QUEUED", completedWaitpointCount: 0 },
            { status: "PENDING_EXECUTING", completedWaitpointCount: 0 },
            { status: "EXECUTING", completedWaitpointCount: 0 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 50 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 100 },
            { status: "EXECUTING", completedWaitpointCount: 100 },
            { status: "FINISHED", completedWaitpointCount: 100 },
          ],
        });

        // Query from early snapshot
        const result = await engine.getSnapshotsSince({
          runId: scenario.run.id,
          snapshotId: scenario.snapshots[2].id, // After PENDING_EXECUTING
        });

        expect(result).not.toBeNull();
        expect(result!.length).toBe(6); // EXECUTING through FINISHED

        // Latest should have all 100 waitpoints
        const latest = result![result!.length - 1];
        expect(latest.completedWaitpoints.length).toBe(100);

        // Verify all earlier snapshots have empty waitpoints
        for (let i = 0; i < result!.length - 1; i++) {
          expect(result![i].completedWaitpoints.length).toBe(0);
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "direct test: zombie run scenario - 236 waitpoints with 100KB outputs, 24 snapshots",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
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
        // This scenario matches the exact conditions that caused the NAPI error
        // 24 snapshots × 236 waitpoints × 100KB = ~570MB if not optimized
        const scenario = await setupTestScenario(prisma, authenticatedEnvironment, {
          totalWaitpoints: 236,
          outputSizeKB: 100,
          snapshotConfigs: [
            { status: "RUN_CREATED", completedWaitpointCount: 0 },
            { status: "QUEUED", completedWaitpointCount: 0 },
            { status: "PENDING_EXECUTING", completedWaitpointCount: 0 },
            { status: "EXECUTING", completedWaitpointCount: 0 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 0 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 100 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 200 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
            { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
            { status: "QUEUED", completedWaitpointCount: 236 },
            { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
            { status: "EXECUTING", completedWaitpointCount: 236 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
            { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
            { status: "QUEUED", completedWaitpointCount: 236 },
            { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
            { status: "EXECUTING", completedWaitpointCount: 236 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
            { status: "SUSPENDED", completedWaitpointCount: 236, hasCheckpoint: true },
            { status: "QUEUED", completedWaitpointCount: 236 },
            { status: "PENDING_EXECUTING", completedWaitpointCount: 236 },
            { status: "EXECUTING", completedWaitpointCount: 236 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 236 },
            { status: "EXECUTING", completedWaitpointCount: 236 },
          ],
        });

        expect(scenario.snapshots.length).toBe(24);
        expect(scenario.waitpoints.length).toBe(236);

        // Query from the 6th snapshot (after waitpoints start completing)
        const queryFromIndex = 5;
        const result = await engine.getSnapshotsSince({
          runId: scenario.run.id,
          snapshotId: scenario.snapshots[queryFromIndex].id,
        });

        expect(result).not.toBeNull();
        // Should return snapshots after index 5, which is 24 - 6 = 18 snapshots
        expect(result!.length).toBe(24 - queryFromIndex - 1);

        // Latest should have all 236 waitpoints
        const latest = result![result!.length - 1];
        expect(latest.completedWaitpoints.length).toBe(236);

        // All other snapshots should have 0 waitpoints (optimization)
        for (let i = 0; i < result!.length - 1; i++) {
          expect(result![i].completedWaitpoints.length).toBe(0);
        }

        // Verify the outputs are present and correct size
        for (const wp of latest.completedWaitpoints) {
          expect(wp.output).toBeDefined();
          // ~100KB output as JSON string
          expect(typeof wp.output).toBe("string");
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "direct test: verifies chunked fetching works with 500+ waitpoints",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
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
        // 500 waitpoints requires 5 chunks (100 per chunk)
        const scenario = await setupTestScenario(prisma, authenticatedEnvironment, {
          totalWaitpoints: 500,
          outputSizeKB: 10, // Smaller outputs for faster test
          snapshotConfigs: [
            { status: "RUN_CREATED", completedWaitpointCount: 0 },
            { status: "QUEUED", completedWaitpointCount: 0 },
            { status: "EXECUTING", completedWaitpointCount: 0 },
            { status: "EXECUTING_WITH_WAITPOINTS", completedWaitpointCount: 500 },
            { status: "EXECUTING", completedWaitpointCount: 500 },
          ],
        });

        const result = await engine.getSnapshotsSince({
          runId: scenario.run.id,
          snapshotId: scenario.snapshots[0].id,
        });

        expect(result).not.toBeNull();
        expect(result!.length).toBe(4);

        const latest = result![result!.length - 1];
        expect(latest.completedWaitpoints.length).toBe(500);

        // All other snapshots should be empty
        for (let i = 0; i < result!.length - 1; i++) {
          expect(result![i].completedWaitpoints.length).toBe(0);
        }
      } finally {
        await engine.quit();
      }
    }
  );
});
