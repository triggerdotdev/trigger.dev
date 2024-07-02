import { logger, task, wait } from "@trigger.dev/sdk/v3";
import { setTimeout } from "node:timers/promises";

export const loggingTask = task({
  id: "logging-task-2",
  run: async () => {
    console.log("Hello world");
  },
});

export const waitForever = task({
  id: "wait-forever",
  run: async (payload: { freeze?: boolean }) => {
    if (payload.freeze) {
      await wait.for({ years: 9999 });
    } else {
      await logger.trace("Waiting..", async () => {
        await setTimeout(2147483647);
      });
    }
  },
});

export const consecutiveWaits = task({
  id: "consecutive-waits",
  run: async (payload: { seconds?: number; debug?: boolean }) => {
    logger.log("logs before");
    await wait.for({ seconds: payload.seconds ?? 5 });
    if (payload.debug) {
      await wait.for({ seconds: 30 });
    }
    await wait.for({ seconds: payload.seconds ?? 5 });
    if (payload.debug) {
      await wait.for({ seconds: 30 });
    }
    logger.log("logs after");
  },
});

export const waitAminute = task({
  id: "wait-a-minute",
  run: async (payload: { seconds?: number }) => {
    logger.log("waitAminute: before");
    await wait.for({ seconds: payload.seconds ?? 60 });
    logger.log("waitAminute: after");
  },
});

export const consecutiveDependencies = task({
  id: "consecutive-dependencies",
  run: async (payload: { seconds?: number }) => {
    logger.log("logs before");
    await waitAminute.triggerAndWait({ seconds: payload.seconds });
    await waitAminute.triggerAndWait({ seconds: payload.seconds });
    logger.log("logs after");
  },
});

export const consecutiveWaitAndDependency = task({
  id: "consecutive-wait-and-dependency",
  run: async (payload: { seconds?: number }) => {
    logger.log("logs before");
    await wait.for({ seconds: payload.seconds ?? 5 });
    await waitAminute.triggerAndWait({ seconds: payload.seconds });
    logger.log("logs after");
  },
});

export const consecutiveDependencyAndWait = task({
  id: "consecutive-dependency-and-wait",
  run: async (payload: { seconds?: number }) => {
    logger.log("logs before");
    await waitAminute.triggerAndWait({ seconds: payload.seconds });
    await wait.for({ seconds: payload.seconds ?? 5 });
    logger.log("logs after");
  },
});

export const unfriendlyIdTask = task({
  id: "hello/world:task-1",
  run: async () => {
    console.log("Hello world");
  },
});

export const oomTask = task({
  id: "oom-task",
  machine: {
    preset: "micro",
  },
  run: async () => {
    logger.info("running out of memory below this line");

    let a = "a";

    try {
      while (true) {
        a += a;
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : "Unknown error", { error });

      let b = [];
      while (true) {
        b.push(a.replace(/a/g, "b"));
      }
    }
  },
});
