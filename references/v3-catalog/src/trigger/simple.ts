import "server-only";
import { envvars, logger, task, wait } from "@trigger.dev/sdk/v3";
import { traceAsync } from "@/telemetry";

export const simplestTask = task({
  id: "fetch-post-task",
  run: async (payload: { url: string }) => {
    const response = await fetch(payload.url, {
      method: "POST",
      body: JSON.stringify({
        hello: "world",
        taskId: "fetch-post-task",
        foo: "barrrrrrrrrrrrrrrrrrrrrrr",
      }),
    });

    return response.json();
  },
});

export const taskWithSpecialCharacters = task({
  id: "admin:special-characters",
  run: async (payload: { url: string }) => {
    await traceAsync("taskWithSpecialCharacters", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    return {
      message: "This task has special characters in its ID",
    };
  },
});

export const createJsonHeroDoc = task({
  id: "create-jsonhero-doc",
  run: async (payload: { title: string; content: any }, { ctx }) => {
    // Sleep for 5 seconds
    await wait.for({ seconds: 5 });

    const response = await fetch("https://jsonhero.io/api/create.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `${payload.title} v2`,
        content: {
          payload: payload.content,
          __triggerContext: ctx,
        },
        readOnly: true,
      }),
    });

    const json: any = await response.json();

    return json;
  },
});

export const immediateReturn = task({
  id: "immediateReturn",
  run: async (payload: any, { ctx }) => {
    console.info("some");
    console.warn("random");
    console.error("logs");
  },
});

export const simulateError = task({
  id: "simulateError",
  run: async (payload: { message: string }) => {
    // Sleep for 1 second
    await new Promise((resolve) => setTimeout(resolve, 1000));

    thisFunctionWillThrow();
  },
});

function thisFunctionWillThrow() {
  throw new Error("This function will throw");
}

export const parentTask = task({
  id: "parent-task",
  run: async (payload: { message: string }, { ctx }) => {
    logger.info("Parent task payload", { payload });

    console.info("This is an info message");
    logger.info("This is an info message from logger.info");
    console.log(JSON.stringify({ ctx, message: "This is the parent task contexts" }));
    logger.log(JSON.stringify({ ctx, message: "This is the parent task context from logger.log" }));
    console.warn("You've been warned buddy");
    logger.warn("You've been warned buddy from logger.warn");
    console.error("This is an error message");
    logger.error("This is an error message from logger.error");

    await wait.for({ seconds: 5 });

    const childTaskResponse = await childTask.triggerAndWait({
      message: payload.message,
      forceError: false,
    });

    logger.info("Child task response", { childTaskResponse });

    await childTask.trigger({
      message: `${payload.message} - 2.a`,
      forceError: true,
    });

    return {
      message: payload.message,
      childTaskResponse,
    };
  },
});

export const childTask = task({
  id: "child-task",
  run: async (
    payload: { message: string; forceError: boolean; delayInSeconds?: number },
    { ctx }
  ) => {
    logger.info("Child task payload", { payload });
    logger.info("Child task payload 2", { payload });
    logger.info("Child task payload 3", { payload });
    logger.info("Child task payload 4", { payload });
    logger.info("Child task payload 5", { payload });

    await wait.for({ seconds: payload.delayInSeconds ?? 5 });

    logger.info("Child task payload 6", { payload });
    logger.info("Child task payload 7", { payload });
    logger.info("Child task payload 8", { payload });

    const response = await fetch("https://jsonhero.io/api/create.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "childTask payload and ctxr",
        content: {
          payload,
          ctx,
        },
        readOnly: true,
      }),
    });

    const json: any = await response.json();

    logger.info("JSONHero response", { json });

    if (payload.forceError) {
      throw new Error(`Forced error: ${payload.message}`);
    }

    return {
      message: "This is the child task",
      parentMessage: payload.message,
    };
  },
});
