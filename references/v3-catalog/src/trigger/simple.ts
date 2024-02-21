import { task, wait, type Context, logger } from "@trigger.dev/sdk/v3";

export const simplestTask = task({
  id: "fetch-post-task",
  run: async ({ payload }: { payload: { url: string } }) => {
    const response = await fetch(payload.url, {
      method: "POST",
      body: JSON.stringify({
        hello: "world",
        taskId: "fetch-post-task",
        foo: "barrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
      }),
    });

    return response.json();
  },
});

export const createJsonHeroDoc = task({
  id: "create-jsonhero-doc",
  run: async ({ payload, ctx }: { payload: { title: string; content: any }; ctx: Context }) => {
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

export const simulateError = task({
  id: "simulateError",
  run: async ({ payload, ctx }: { payload: { message: string }; ctx: Context }) => {
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
  run: async ({ payload, ctx }: { payload: { message: string }; ctx: Context }) => {
    logger.info("Parent task payload", { payload });

    console.info("This is an info message");
    console.log(JSON.stringify({ ctx, message: "This is the parent task context" }));
    console.warn("You've been warned buddy");
    console.error("This is an error message");

    await wait.for({ seconds: 5 });

    const childTaskResponse = await childTask.triggerAndWait({
      payload: {
        message: payload.message,
        forceError: false,
      },
    });

    logger.info("Child task response", { childTaskResponse });

    await childTask.trigger({
      payload: {
        message: `${payload.message} - 2.a`,
        forceError: true,
      },
    });

    return {
      message: payload.message,
      childTaskResponse,
    };
  },
});

export const childTask = task({
  id: "child-task",
  run: async ({
    payload,
    ctx,
  }: {
    payload: { message: string; forceError: boolean };
    ctx: Context;
  }) => {
    logger.info("Child task payload", { payload });

    await wait.for({ seconds: 10 });

    const response = await fetch("https://jsonhero.io/api/create.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "childTask payload and ctx",
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
