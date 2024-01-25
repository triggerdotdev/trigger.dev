import { task, wait, type Context } from "@trigger.dev/sdk/v3";

export const simplestTask = task({
  id: "fetch-post-task",
  run: async ({ payload }: { payload: { url: string } }) => {
    const response = await fetch(payload.url, {
      method: "POST",
      body: JSON.stringify({ hello: "world", taskId: "fetch-post-task", foo: "barrrrrrrrrrrrr" }),
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
    await wait.for({ seconds: 5 });

    const childTaskResponse = await childTask.triggerAndWait({
      payload: {
        message: payload.message,
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
  run: async ({ payload, ctx }: { payload: { message: string }; ctx: Context }) => {
    await wait.for({ seconds: 10 });

    return {
      message: "This is the child task",
      parentMessage: payload.message,
    };
  },
});
