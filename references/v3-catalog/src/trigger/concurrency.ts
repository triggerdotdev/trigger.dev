import { logger, queue, task, wait } from "@trigger.dev/sdk/v3";

export const oneAtATime = task({
  id: "on-at-a-time",
  queue: {
    concurrencyLimit: 1,
  },
  run: async (payload: { message: string }) => {
    logger.info("One at a time task payload", { payload });

    await wait.for({ seconds: 10 });

    return {
      finished: new Date().toISOString(),
    };
  },
});

export const testConcurrency = task({
  id: "test-concurrency-controller",
  run: async ({
    count = 10,
    delay = 5000,
    childDelay = 1000,
  }: {
    count: number;
    delay: number;
    childDelay: number;
  }) => {
    logger.info(`Running ${count} tasks baby`);

    await testConcurrencyParent.batchTrigger(
      Array.from({ length: count }).map((_, index) => ({
        payload: {
          delay,
          childDelay,
        },
      }))
    );

    logger.info(`All ${count} tasks triggered`);

    // wait for about 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Now trigger the parent task again
    await testConcurrencyParent.trigger({
      delay,
      childDelay,
    });

    return {
      finished: new Date().toISOString(),
    };
  },
});

export const testConcurrencyParent = task({
  id: "test-concurrency-parent",
  run: async ({ delay = 5000, childDelay = 1000 }: { delay: number; childDelay: number }) => {
    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    logger.info(`Delay of ${delay}ms completed`);

    return await testConcurrencyChild.triggerAndWait({
      delay: childDelay,
    });
  },
});

export const testConcurrencyChild = task({
  id: "test-concurrency-child",
  queue: {
    concurrencyLimit: 10,
  },
  run: async ({ delay = 5000 }: { delay: number }) => {
    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    logger.info(`Delay of ${delay}ms completed`);

    return {
      completedAt: new Date(),
    };
  },
});

export const testReserveConcurrencyRecursiveWaits = task({
  id: "test-reserve-concurrency-recursive-waits",
  retry: {
    maxAttempts: 1,
  },
  run: async ({
    delay = 5000,
    depth = 2,
    currentDepth = 0,
    batchSize = 1,
    useBatch,
  }: {
    delay: number;
    depth: number;
    currentDepth?: number;
    batchSize?: number;
    useBatch?: boolean;
  }) => {
    logger.info(`Running task at depth ${currentDepth} 1`);

    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    logger.info(`Delay of ${delay}ms completed`);

    if (currentDepth < depth) {
      logger.info(`Triggering child task at depth ${currentDepth + 1}`);

      if (useBatch) {
        await testReserveConcurrencyRecursiveWaits.batchTriggerAndWait(
          Array.from({ length: batchSize }).map((_, index) => ({
            payload: {
              delay,
              depth,
              currentDepth: currentDepth + 1,
              batchSize,
              useBatch,
            },
          }))
        );
      } else {
        await testReserveConcurrencyRecursiveWaits.triggerAndWait({
          delay,
          depth,
          currentDepth: currentDepth + 1,
          batchSize,
          useBatch,
        });
      }

      logger.info(`Child task at depth ${currentDepth + 1} completed`);
    }

    logger.info(`Task at depth ${currentDepth} completed`);

    return {
      completedAt: new Date(),
    };
  },
});

export const testChildTaskPriorityController = task({
  id: "test-child-task-priority-controller",
  run: async ({ delay = 5000 }: { delay: number }) => {
    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    return {
      completedAt: new Date(),
    };
  },
});

export const testChildTaskPriorityParent = task({
  id: "test-child-task-priority-parent",
  run: async ({ delay = 5000 }: { delay: number }) => {
    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    await testChildTaskPriorityChild.triggerAndWait({
      delay,
    });

    logger.info(`Delay of ${delay}ms completed`);

    return {
      completedAt: new Date(),
    };
  },
});

export const testChildTaskPriorityChildCreator = task({
  id: "test-child-task-priority-child-creator",
  run: async ({ delay = 5000 }: { delay: number }) => {
    await testChildTaskPriorityChild.batchTrigger([
      { payload: { delay, propagate: false } },
      { payload: { delay, propagate: false } },
      { payload: { delay, propagate: false } },
      { payload: { delay, propagate: false } },
    ]);

    return {
      completedAt: new Date(),
    };
  },
});

export const testChildTaskPriorityChild = task({
  id: "test-child-task-priority-child",
  queue: {
    concurrencyLimit: 1,
  },
  run: async ({ delay = 5000, propagate }: { delay: number; propagate?: boolean }) => {
    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (typeof propagate === "undefined" || propagate) {
      await testChildTaskPriorityGrandChild.triggerAndWait({
        delay,
      });
    }

    logger.info(`Delay of ${delay}ms completed`);

    return {
      completedAt: new Date(),
    };
  },
});

export const testChildTaskPriorityGrandChildCreator = task({
  id: "test-child-task-priority-grand-child-creator",
  run: async ({ delay = 5000 }: { delay: number }) => {
    await testChildTaskPriorityGrandChild.batchTrigger([
      { payload: { delay } },
      { payload: { delay } },
      { payload: { delay } },
    ]);

    logger.info(`Delay of ${delay}ms completed`);

    return {
      completedAt: new Date(),
    };
  },
});

export const testChildTaskPriorityGrandChild = task({
  id: "test-child-task-priority-grandchild",
  queue: {
    concurrencyLimit: 1,
  },
  run: async ({ delay = 5000 }: { delay: number }) => {
    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    logger.info(`Delay of ${delay}ms completed`);

    return {
      completedAt: new Date(),
    };
  },
});

export const myQueue = queue({
  name: "my-queue",
  concurrencyLimit: 1,
});

export const parentTask = task({
  id: "parent-task",
  queue: myQueue,
  run: async (payload) => {
    //trigger a subtask
    await subtask.triggerAndWait(payload);
  },
});

export const subtask = task({
  id: "subtask",
  queue: myQueue,
  run: async (payload) => {
    //trigger a subtask
    await subsubtask.triggerAndWait(payload);
  },
});

export const subsubtask = task({
  id: "subsubtask",
  queue: myQueue,
  run: async (payload) => {
    //...
  },
});
