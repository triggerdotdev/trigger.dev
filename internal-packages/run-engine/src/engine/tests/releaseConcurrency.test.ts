import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { engineTest } from "./utils/engineTest.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine Releasing Concurrency", () => {
  engineTest.scoped({
    engineOptions: {
      queue: { masterQueueConsumersDisabled: true, processWorkerQueueDebounceMs: 50 },
    },
  });

  engineTest("defaults to releasing env concurrency only", async ({ engine, prisma }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
        workerQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );

    await setTimeout(500);

    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
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

    await engine.quit();
  });

  engineTest("releases all concurrency when configured on queue", async ({ engine, prisma }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
        workerQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );

    await setTimeout(500);

    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
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
  });

  engineTest("releases all concurrency for unlimited queues", async ({ engine, prisma }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
        workerQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );

    await setTimeout(500);

    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
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
  });
});
