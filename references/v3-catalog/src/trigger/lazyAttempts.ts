import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const lazyImmediate = task({
  id: "lazy-immediate",
  run: async (payload: { forceError?: boolean }) => {
    logger.info("Log something", { payload });
    logger.info("Log something else", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyWait = task({
  id: "lazy-wait",
  run: async (payload: { forceError?: boolean; delayInSeconds?: number }) => {
    logger.info("Log something", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 1 });

    logger.info("Log something else", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazySingleDependency = task({
  id: "lazy-single-dependency",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const result = await lazyWait.triggerAndWait({
      delayInSeconds: payload.delayInSeconds,
      forceError: payload.forceChildError,
    });
    logger.info("Single result", { result });

    logger.info("Log something else", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyBatchDependency = task({
  id: "lazy-batch-dependency",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const results = await lazyWait.batchTriggerAndWait([
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
    ]);
    logger.info("Batch results", { results });

    logger.info("Log something else", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyConsecutiveWaits = task({
  id: "lazy-consecutive-waits",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 1 });

    logger.info("Log something else", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 1 });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyConsecutiveDependencies = task({
  id: "lazy-consecutive-dependencies",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const result = await lazyWait.triggerAndWait({
      delayInSeconds: payload.delayInSeconds,
      forceError: payload.forceChildError,
    });
    logger.info("Single result #1", { result });

    logger.info("Log something else", { payload });

    const result2 = await lazyWait.triggerAndWait({
      delayInSeconds: payload.delayInSeconds,
      forceError: payload.forceChildError,
    });
    logger.info("Single result #2", { result2 });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyConsecutiveBatchDependencies = task({
  id: "lazy-consecutive-batch-dependencies",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const results = await lazyWait.batchTriggerAndWait([
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
    ]);
    logger.info("Batch results #1", { results });

    logger.info("Log something else", { payload });

    const results2 = await lazyWait.batchTriggerAndWait([
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
    ]);
    logger.info("Batch results #2", { results2 });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyWaitThenSingleDependency = task({
  id: "lazy-wait-then-single-dependency",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 1 });

    logger.info("Log something else", { payload });

    const result = await lazyWait.triggerAndWait({
      delayInSeconds: payload.delayInSeconds,
      forceError: payload.forceChildError,
    });
    logger.info("Single result", { result });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyWaitThenBatchDependency = task({
  id: "lazy-wait-then-batch-dependency",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 1 });

    logger.info("Log something else", { payload });

    const results = await lazyWait.batchTriggerAndWait([
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
    ]);
    logger.info("Batch results", { results });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazySingleDependencyThenWait = task({
  id: "lazy-single-dependency-then-wait",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const result = await lazyWait.triggerAndWait({
      delayInSeconds: payload.delayInSeconds,
      forceError: payload.forceChildError,
    });
    logger.info("Single result", { result });

    logger.info("Log something else", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 1 });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazySingleDependencyThenBatch = task({
  id: "lazy-single-dependency-then-batch",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const result = await lazyWait.triggerAndWait({
      delayInSeconds: payload.delayInSeconds,
      forceError: payload.forceChildError,
    });
    logger.info("Single result", { result });

    logger.info("Log something else", { payload });

    const results = await lazyWait.batchTriggerAndWait([
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
    ]);
    logger.info("Batch results", { results });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyBatchDependencyThenWait = task({
  id: "lazy-batch-dependency-then-wait",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const results = await lazyWait.batchTriggerAndWait([
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
    ]);
    logger.info("Batch results", { results });

    logger.info("Log something else", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 1 });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});

export const lazyBatchDependencyThenSingle = task({
  id: "lazy-batch-dependency-then-single",
  run: async (payload: {
    forceError?: boolean;
    forceChildError?: boolean;
    delayInSeconds?: number;
  }) => {
    logger.info("Log something", { payload });

    const results = await lazyWait.batchTriggerAndWait([
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
      { payload: { delayInSeconds: payload.delayInSeconds, forceError: payload.forceChildError } },
    ]);
    logger.info("Batch results", { results });

    logger.info("Log something else", { payload });

    const result = await lazyWait.triggerAndWait({
      delayInSeconds: payload.delayInSeconds,
      forceError: payload.forceChildError,
    });
    logger.info("Single result", { result });

    logger.info("Log something else again", { payload });

    if (payload.forceError) {
      throw new Error("Forced error");
    }

    return {
      message: "This is a message",
      payload,
    };
  },
});
