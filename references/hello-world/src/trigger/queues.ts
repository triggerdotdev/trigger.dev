import { batch, logger, queue, queues, task } from "@trigger.dev/sdk/v3";

export const queuesTester = task({
  id: "queues-tester",
  run: async (payload: any, { ctx }) => {
    const q = await queues.list();

    for await (const queue of q) {
      logger.log("Queue", { queue });
    }

    const retrievedFromId = await queues.retrieve(ctx.queue.id);
    logger.log("Retrieved from ID", { retrievedFromId });

    const retrievedFromCtxName = await queues.retrieve({
      type: "task",
      name: ctx.queue.name,
    });
    logger.log("Retrieved from name", { retrievedFromCtxName });

    //pause the queue
    const pausedQueue = await queues.pause({
      type: "task",
      name: "queues-tester",
    });
    logger.log("Paused queue", { pausedQueue });

    const retrievedFromName = await queues.retrieve({
      type: "task",
      name: "queues-tester",
    });
    logger.log("Retrieved from name", { retrievedFromName });

    //resume the queue
    const resumedQueue = await queues.resume({
      type: "task",
      name: "queues-tester",
    });
    logger.log("Resumed queue", { resumedQueue });
  },
});

const myCustomQueue = queue({
  name: "my-custom-queue",
  concurrencyLimit: 1,
});

export const otherQueueTask = task({
  id: "other-queue-task",
  queue: myCustomQueue,
  run: async (payload: any, { ctx }) => {
    logger.log("Other queue task", { payload });
  },
});

import { setTimeout } from "node:timers/promises";

type Payload = {
  id: string;
  waitSeconds: number;
};

export const myQueue = queue({
  name: "shared-queue",
  concurrencyLimit: 2,
});

// First task type that uses shared queue
export const sharedQueueTask1 = task({
  id: "shared-queue-task-1",
  queue: myQueue,
  run: async (payload: Payload) => {
    const startedAt = Date.now();
    logger.info(`Task1 ${payload.id} started at ${startedAt}`);

    await setTimeout(payload.waitSeconds * 1000);

    const completedAt = Date.now();
    logger.info(`Task1 ${payload.id} completed at ${completedAt}`);

    return {
      id: payload.id,
      startedAt,
      completedAt,
    };
  },
});

// Second task type that uses the same queue
export const sharedQueueTask2 = task({
  id: "shared-queue-task-2",
  queue: myQueue,
  run: async (payload: Payload) => {
    const startedAt = Date.now();
    logger.info(`Task2 ${payload.id} started at ${startedAt}`);

    await setTimeout(payload.waitSeconds * 1000);

    const completedAt = Date.now();
    logger.info(`Task2 ${payload.id} completed at ${completedAt}`);

    return {
      id: payload.id,
      startedAt,
      completedAt,
    };
  },
});

export const sharedQueueTask3 = task({
  id: "shared-queue-task-3",
  queue: myQueue,
  run: async (payload: Payload) => {
    const startedAt = Date.now();
    logger.info(`Task2 ${payload.id} started at ${startedAt}`);

    await setTimeout(payload.waitSeconds * 1000);

    const completedAt = Date.now();
    logger.info(`Task2 ${payload.id} completed at ${completedAt}`);

    return {
      id: payload.id,
      startedAt,
      completedAt,
    };
  },
});

export const sharedQueueTask4 = task({
  id: "shared-queue-task-4",
  queue: myQueue,
  run: async (payload: Payload) => {
    const startedAt = Date.now();
    logger.info(`Task2 ${payload.id} started at ${startedAt}`);

    await setTimeout(payload.waitSeconds * 1000);

    const completedAt = Date.now();
    logger.info(`Task2 ${payload.id} completed at ${completedAt}`);

    return {
      id: payload.id,
      startedAt,
      completedAt,
    };
  },
});

export const sharedQueueTask5 = task({
  id: "shared-queue-task-5",
  queue: myQueue,
  run: async (payload: Payload) => {
    const startedAt = Date.now();
    logger.info(`Task2 ${payload.id} started at ${startedAt}`);

    await setTimeout(payload.waitSeconds * 1000);

    const completedAt = Date.now();
    logger.info(`Task2 ${payload.id} completed at ${completedAt}`);

    return {
      id: payload.id,
      startedAt,
      completedAt,
    };
  },
});

// Test task that verifies shared queue concurrency
export const sharedQueueTestTask = task({
  id: "shared-queue-test",
  retry: {
    maxAttempts: 1,
  },
  // 4 minutes
  maxDuration: 240,
  run: async (payload, { ctx }) => {
    logger.info("Starting shared queue concurrency test");

    // Trigger mix of both task types (5 total tasks)
    // With concurrencyLimit: 2, we expect only 2 running at once
    // regardless of task type
    const results = await batch.triggerAndWait([
      { id: sharedQueueTask1.id, payload: { id: "t1-1", waitSeconds: 4 } },
      { id: sharedQueueTask2.id, payload: { id: "t2-1", waitSeconds: 4 } },
      { id: sharedQueueTask1.id, payload: { id: "t1-2", waitSeconds: 4 } },
      { id: sharedQueueTask2.id, payload: { id: "t2-2", waitSeconds: 4 } },
      { id: sharedQueueTask1.id, payload: { id: "t1-3", waitSeconds: 4 } },
    ]);

    // Verify all tasks completed successfully
    if (!results.runs.every((r) => r.ok)) {
      throw new Error("One or more tasks failed");
    }

    // Get all executions sorted by start time
    const executions = results.runs.map((r) => r.output).sort((a, b) => a.startedAt - b.startedAt);

    // For each point in time, count how many tasks were running
    let maxConcurrent = 0;
    for (let i = 0; i < executions.length; i++) {
      const current = executions[i];
      const concurrent =
        executions.filter(
          (task) =>
            task.id !== current.id && // not the same task
            task.startedAt <= current.startedAt && // started before or at same time
            task.completedAt >= current.startedAt // hadn't completed yet
        ).length + 1; // +1 for current task

      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }

    // Verify we never exceeded the concurrency limit
    if (maxConcurrent > 2) {
      throw new Error(`Expected maximum of 2 concurrent tasks, but found ${maxConcurrent}`);
    }

    // Verify tasks from both types were able to run
    const task1Runs = executions.filter((e) => e.id.startsWith("t1-")).length;
    const task2Runs = executions.filter((e) => e.id.startsWith("t2-")).length;

    if (task1Runs === 0 || task2Runs === 0) {
      throw new Error(
        `Expected both task types to run, but got ${task1Runs} task1 runs and ${task2Runs} task2 runs`
      );
    }

    return {
      executions,
      maxConcurrent,
      task1Count: task1Runs,
      task2Count: task2Runs,
    };
  },
});
