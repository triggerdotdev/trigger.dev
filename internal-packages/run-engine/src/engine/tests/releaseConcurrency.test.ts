import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { EventBusEventArgs } from "../eventBus.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine Releasing Concurrency", () => {
  containerTest("defaults to releasing env concurrency only", async ({ prisma, redisOptions }) => {
    //create environment
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
      releaseConcurrency: {
        maxTokensRatio: 1,
        maxRetries: 3,
        consumersCount: 1,
        pollInterval: 500,
        batchSize: 1,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });
    const taskIdentifier = "test-task";

    await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

    const run = await engine.trigger(
      {
        number: 1,
        friendlyId: "run_p1234",
        environment: authenticatedEnvironment,
        taskIdentifier,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "t12345",
        spanId: "s12345",
        masterQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );

    const dequeued = await engine.dequeueFromMasterQueue({
      consumerId: "test_12345",
      masterQueue: run.masterQueue,
      maxRunCount: 10,
    });

    const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
      authenticatedEnvironment,
      `task/${taskIdentifier}`
    );

    expect(queueConcurrency).toBe(1);

    const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
      authenticatedEnvironment
    );

    expect(envConcurrency).toBe(1);

    // create an attempt
    const attemptResult = await engine.startRunAttempt({
      runId: dequeued[0].run.id,
      snapshotId: dequeued[0].snapshot.id,
    });

    expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

    // create a manual waitpoint
    const result = await engine.createManualWaitpoint({
      environmentId: authenticatedEnvironment.id,
      projectId: authenticatedEnvironment.projectId,
    });

    // Block the run, not specifying any release concurrency option
    const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
      runId: run.id,
      waitpoints: result.waitpoint.id,
      projectId: authenticatedEnvironment.projectId,
      organizationId: authenticatedEnvironment.organizationId,
    });

    expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

    // Now confirm the queue has the same concurrency as before
    const queueConcurrencyAfter = await engine.runQueue.currentConcurrencyOfQueue(
      authenticatedEnvironment,
      `task/${taskIdentifier}`
    );

    expect(queueConcurrencyAfter).toBe(1);

    // Now confirm the environment has a concurrency of 0
    const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
      authenticatedEnvironment
    );

    expect(envConcurrencyAfter).toBe(0);

    await engine.completeWaitpoint({
      id: result.waitpoint.id,
    });

    await setTimeout(500);

    // Test that we've reacquired the queue concurrency
    const queueConcurrencyAfterWaitpoint = await engine.runQueue.currentConcurrencyOfQueue(
      authenticatedEnvironment,
      `task/${taskIdentifier}`
    );

    expect(queueConcurrencyAfterWaitpoint).toBe(1);

    // Test that we've reacquired the environment concurrency
    const envConcurrencyAfterWaitpoint = await engine.runQueue.currentConcurrencyOfEnvironment(
      authenticatedEnvironment
    );

    expect(envConcurrencyAfterWaitpoint).toBe(1);

    // Now we are going to block with another waitpoint, this time specifiying we want to release the concurrency in the waitpoint
    const result2 = await engine.createManualWaitpoint({
      environmentId: authenticatedEnvironment.id,
      projectId: authenticatedEnvironment.projectId,
    });

    const executingWithWaitpointSnapshot2 = await engine.blockRunWithWaitpoint({
      runId: run.id,
      waitpoints: result2.waitpoint.id,
      projectId: authenticatedEnvironment.projectId,
      organizationId: authenticatedEnvironment.organizationId,
      releaseConcurrency: true,
    });

    expect(executingWithWaitpointSnapshot2.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

    // Test that we've released the queue concurrency
    const queueConcurrencyAfterWaitpoint2 = await engine.runQueue.currentConcurrencyOfQueue(
      authenticatedEnvironment,
      `task/${taskIdentifier}`
    );

    expect(queueConcurrencyAfterWaitpoint2).toBe(0);

    // Test that we've released the environment concurrency
    const envConcurrencyAfterWaitpoint2 = await engine.runQueue.currentConcurrencyOfEnvironment(
      authenticatedEnvironment
    );

    expect(envConcurrencyAfterWaitpoint2).toBe(0);

    // Complete the waitpoint and make sure the run reacquires the queue and environment concurrency
    await engine.completeWaitpoint({
      id: result2.waitpoint.id,
    });

    await setTimeout(500);

    // Test that we've reacquired the queue concurrency
    const queueConcurrencyAfterWaitpoint3 = await engine.runQueue.currentConcurrencyOfQueue(
      authenticatedEnvironment,
      `task/${taskIdentifier}`
    );

    expect(queueConcurrencyAfterWaitpoint3).toBe(1);
  });

  containerTest(
    "releases all concurrency when configured on queue",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        releaseConcurrency: {
          maxTokensRatio: 1,
          maxRetries: 3,
          consumersCount: 1,
          pollInterval: 500,
          batchSize: 1,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        taskIdentifier,
        undefined,
        undefined,
        {
          releaseConcurrencyOnWaitpoint: true,
        }
      );

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrency).toBe(1);

      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrency).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      // create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      // Block the run, not specifying any release concurrency option
      const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Now confirm the queue has the same concurrency as before
      const queueConcurrencyAfter = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfter).toBe(0);

      // Now confirm the environment has a concurrency of 0
      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfter).toBe(0);

      // Complete the waitpoint and make sure the run reacquires the queue and environment concurrency
      await engine.completeWaitpoint({
        id: result.waitpoint.id,
      });

      await setTimeout(500);

      // Test that we've reacquired the queue concurrency
      const queueConcurrencyAfterWaitpoint = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterWaitpoint).toBe(1);

      // Test that we've reacquired the environment concurrency
      const envConcurrencyAfterWaitpoint = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterWaitpoint).toBe(1);

      // Now we are going to block with another waitpoint, this time specifiying we dont want to release the concurrency in the waitpoint
      const result2 = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      const executingWithWaitpointSnapshot2 = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result2.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
        releaseConcurrency: false,
      });

      expect(executingWithWaitpointSnapshot2.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Test that we've not released the queue concurrency
      const queueConcurrencyAfterWaitpoint2 = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterWaitpoint2).toBe(1);

      // Test that we've still released the environment concurrency since we always release env concurrency
      const envConcurrencyAfterWaitpoint2 = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterWaitpoint2).toBe(0);
    }
  );

  containerTest(
    "releases all concurrency for unlimited queues",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        releaseConcurrency: {
          maxTokensRatio: 1,
          maxRetries: 3,
          consumersCount: 1,
          pollInterval: 500,
          batchSize: 1,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        taskIdentifier,
        undefined,
        undefined,
        {
          releaseConcurrencyOnWaitpoint: true,
          concurrencyLimit: null,
        }
      );

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrency).toBe(1);

      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrency).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      // create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      // Block the run, not specifying any release concurrency option
      const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Now confirm the queue has the same concurrency as before
      const queueConcurrencyAfter = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfter).toBe(0);

      // Now confirm the environment has a concurrency of 0
      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfter).toBe(0);

      // Complete the waitpoint and make sure the run reacquires the queue and environment concurrency
      await engine.completeWaitpoint({
        id: result.waitpoint.id,
      });

      await setTimeout(500);

      // Test that we've reacquired the queue concurrency
      const queueConcurrencyAfterWaitpoint = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterWaitpoint).toBe(1);

      // Test that we've reacquired the environment concurrency
      const envConcurrencyAfterWaitpoint = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterWaitpoint).toBe(1);

      // Now we are going to block with another waitpoint, this time specifiying we dont want to release the concurrency in the waitpoint
      const result2 = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      const executingWithWaitpointSnapshot2 = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result2.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
        releaseConcurrency: false,
      });

      expect(executingWithWaitpointSnapshot2.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Test that we've not released the queue concurrency
      const queueConcurrencyAfterWaitpoint2 = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterWaitpoint2).toBe(1);

      // Test that we've still released the environment concurrency since we always release env concurrency
      const envConcurrencyAfterWaitpoint2 = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterWaitpoint2).toBe(0);
    }
  );

  containerTest(
    "delays env concurrency release when token unavailable",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        releaseConcurrency: {
          maxTokensRatio: 0.1, // 10% of the concurrency limit = 1 token
          maxRetries: 3,
          consumersCount: 1,
          pollInterval: 500,
          batchSize: 1,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrency).toBe(1);

      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrency).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      // create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      await engine.releaseConcurrencySystem.consumeToken(
        {
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        },
        "test_12345"
      );

      // Block the run, not specifying any release concurrency option
      const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Now confirm the queue has the same concurrency as before
      const queueConcurrencyAfter = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfter).toBe(1);

      // Now confirm the environment is the same as before
      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfter).toBe(1);

      // Now we return the token so the concurrency can be released
      await engine.releaseConcurrencySystem.returnToken(
        {
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        },
        "test_12345"
      );

      // Wait until the token is released
      await setTimeout(1_000);

      // Now the environment should have a concurrency of 0
      const envConcurrencyAfterReturn = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterReturn).toBe(0);

      // and the queue should have a concurrency of 1
      const queueConcurrencyAfterReturn = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterReturn).toBe(1);
    }
  );

  containerTest(
    "delays env concurrency release after checkpoint",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        releaseConcurrency: {
          maxTokensRatio: 0.1, // 10% of the concurrency limit = 1 token
          maxRetries: 3,
          consumersCount: 1,
          pollInterval: 500,
          batchSize: 1,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrency).toBe(1);

      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrency).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      // create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      await engine.releaseConcurrencySystem.consumeToken(
        {
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        },
        "test_12345"
      );

      // Block the run, not specifying any release concurrency option
      const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Now confirm the queue has the same concurrency as before
      const queueConcurrencyAfter = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfter).toBe(1);

      // Now confirm the environment is the same as before
      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfter).toBe(1);

      const checkpointResult = await engine.createCheckpoint({
        runId: run.id,
        snapshotId: executingWithWaitpointSnapshot.id,
        checkpoint: {
          type: "DOCKER",
          reason: "TEST_CHECKPOINT",
          location: "test-location",
          imageRef: "test-image-ref",
        },
      });

      expect(checkpointResult.ok).toBe(true);

      const snapshot = checkpointResult.ok ? checkpointResult.snapshot : null;
      assertNonNullable(snapshot);

      console.log("Snapshot", snapshot);

      expect(snapshot.executionStatus).toBe("SUSPENDED");

      // Now we return the token so the concurrency can be released
      await engine.releaseConcurrencySystem.returnToken(
        {
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        },
        "test_12345"
      );

      // Wait until the token is released
      await setTimeout(1_000);

      // Now the environment should have a concurrency of 0
      const envConcurrencyAfterReturn = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterReturn).toBe(0);

      // and the queue should have a concurrency of 1
      const queueConcurrencyAfterReturn = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterReturn).toBe(1);
    }
  );

  containerTest(
    "maintains concurrency after waitpoint completion",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        releaseConcurrency: {
          maxTokensRatio: 0.1, // 10% of the concurrency limit = 1 token
          maxRetries: 3,
          consumersCount: 1,
          pollInterval: 500,
          batchSize: 1,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrency).toBe(1);

      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrency).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      // create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      await engine.releaseConcurrencySystem.consumeToken(
        {
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        },
        "test_12345"
      );

      // Block the run, not specifying any release concurrency option
      const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Now confirm the queue has the same concurrency as before
      const queueConcurrencyAfter = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfter).toBe(1);

      // Now confirm the environment is the same as before
      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfter).toBe(1);

      // Complete the waitpoint
      await engine.completeWaitpoint({
        id: result.waitpoint.id,
      });

      await setTimeout(1_000);

      // Verify the first run is now in EXECUTING state
      const executionDataAfter = await engine.getRunExecutionData({ runId: run.id });
      expect(executionDataAfter?.snapshot.executionStatus).toBe("EXECUTING");

      // Now we return the token so the concurrency can be released
      await engine.releaseConcurrencySystem.returnToken(
        {
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        },
        "test_12345"
      );

      // give the release concurrency system time to run
      await setTimeout(1_000);

      // Now the environment should have a concurrency of 1
      const envConcurrencyAfterReturn = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterReturn).toBe(1);

      // and the queue should have a concurrency of 1
      const queueConcurrencyAfterReturn = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterReturn).toBe(1);
    }
  );

  containerTest(
    "refills token bucket after waitpoint completion when snapshot not in release queue",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        releaseConcurrency: {
          maxTokensRatio: 0.1, // 10% of the concurrency limit = 1 token
          maxRetries: 3,
          consumersCount: 1,
          pollInterval: 500,
          batchSize: 1,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrency).toBe(1);

      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrency).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      // create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      // Block the run, not specifying any release concurrency option
      const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Now confirm the environment concurrency has been released
      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfter).toBe(0);

      // And confirm the release concurrency system has consumed the token
      const queueMetrics =
        await engine.releaseConcurrencySystem.releaseConcurrencyQueue?.getReleaseQueueMetrics({
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        });

      expect(queueMetrics?.currentTokens).toBe(0);

      await engine.completeWaitpoint({
        id: result.waitpoint.id,
      });

      await setTimeout(1_000);

      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      expect(executionData2?.snapshot.executionStatus).toBe("EXECUTING");

      const queueMetricsAfter =
        await engine.releaseConcurrencySystem.releaseConcurrencyQueue?.getReleaseQueueMetrics({
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        });

      expect(queueMetricsAfter?.currentTokens).toBe(1);
    }
  );

  containerTest(
    "refills token bucket after waitpoint completion when unable to reacquire concurrency, after dequeuing the queued executing run",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        releaseConcurrency: {
          maxTokensRatio: 1,
          maxRetries: 3,
          consumersCount: 1,
          pollInterval: 500,
          batchSize: 1,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        taskIdentifier,
        undefined,
        undefined,
        {
          concurrencyLimit: 1,
        }
      );

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const queueConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrency).toBe(1);

      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrency).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      // create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      // Block the run, specifying the release concurrency option as true
      const executingWithWaitpointSnapshot = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
        releaseConcurrency: true,
      });

      expect(executingWithWaitpointSnapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Now confirm the environment concurrency has been released
      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfter).toBe(0);

      const queueConcurrencyAfter = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfter).toBe(0);

      // And confirm the release concurrency system has consumed the token
      const queueMetrics =
        await engine.releaseConcurrencySystem.releaseConcurrencyQueue?.getReleaseQueueMetrics({
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        });

      expect(queueMetrics?.currentTokens).toBe(9);

      // Create and start second run on the same queue
      const secondRun = await engine.trigger(
        {
          number: 2,
          friendlyId: "run_second",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345-second",
          spanId: "s12345-second",
          masterQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      // Dequeue and start the second run
      const dequeuedSecond = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: secondRun.masterQueue,
        maxRunCount: 10,
      });

      // Now confirm the environment concurrency has been released
      const envConcurrencyAfterSecond = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );

      expect(envConcurrencyAfterSecond).toBe(1);

      const queueConcurrencyAfterSecond = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterSecond).toBe(1);

      const secondAttempt = await engine.startRunAttempt({
        runId: dequeuedSecond[0].run.id,
        snapshotId: dequeuedSecond[0].snapshot.id,
      });

      expect(secondAttempt.snapshot.executionStatus).toBe("EXECUTING");

      // Complete the waitpoint that's blocking the first run
      await engine.completeWaitpoint({
        id: result.waitpoint.id,
      });

      await setTimeout(1_000);

      // Verify that the first run could not reacquire the concurrency so it's back in the queue
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      expect(executionData2?.snapshot.executionStatus).toBe("QUEUED_EXECUTING");

      const queueMetricsAfter =
        await engine.releaseConcurrencySystem.releaseConcurrencyQueue?.getReleaseQueueMetrics({
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        });

      // We've consumed 1 token, so we should have 9 left
      expect(queueMetricsAfter?.currentTokens).toBe(9);

      // Complete the second run so the first run can be dequeued
      await engine.completeRunAttempt({
        runId: dequeuedSecond[0].run.id,
        snapshotId: secondAttempt.snapshot.id,
        completion: {
          ok: true,
          id: dequeuedSecond[0].run.id,
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });

      await setTimeout(500);

      // Check the current concurrency of the queue/environment
      const queueConcurrencyAfterSecondFinished = await engine.runQueue.currentConcurrencyOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );

      expect(queueConcurrencyAfterSecondFinished).toBe(0);

      const envConcurrencyAfterSecondFinished =
        await engine.runQueue.currentConcurrencyOfEnvironment(authenticatedEnvironment);

      expect(envConcurrencyAfterSecondFinished).toBe(0);

      let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
      engine.eventBus.on("workerNotification", (result) => {
        event = result;
      });

      // Verify the first run is back in the queue
      const queuedRun = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      // We don't actually return the run here from dequeuing, it's instead sent to the cluster as a workerNotification
      expect(queuedRun.length).toBe(0);

      assertNonNullable(event);
      const notificationEvent = event as EventBusEventArgs<"workerNotification">[0];
      expect(notificationEvent.run.id).toBe(run.id);
      expect(notificationEvent.snapshot.executionStatus).toBe("EXECUTING");

      // Make sure the token bucket is refilled
      const queueMetricsAfterSecondFinished =
        await engine.releaseConcurrencySystem.releaseConcurrencyQueue?.getReleaseQueueMetrics({
          orgId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          envId: authenticatedEnvironment.id,
        });

      expect(queueMetricsAfterSecondFinished?.currentTokens).toBe(10);
    }
  );
});
