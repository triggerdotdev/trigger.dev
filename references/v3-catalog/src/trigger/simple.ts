import { task, type Context } from "@trigger.dev/sdk/v3";

export const simplestTask = task({
  id: "fetch-post-task",
  run: async ({ payload }: { payload: { url: string } }) => {
    const response = await fetch(payload.url, {
      method: "POST",
      body: JSON.stringify({ hello: "world", taskId: "fetch-post-task", foo: "barrrrrrrrrrrr" }),
    });

    return response.json();
  },
});

export const createJsonHeroDoc = task({
  id: "create-jsonhero-doc",
  run: async ({
    payload,
    context,
  }: {
    payload: { title: string; content: any };
    context: Context;
  }) => {
    // Sleep for 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const response = await fetch("https://jsonhero.io/api/create.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `${payload.title} v2`,
        content: {
          payload: payload.content,
          __triggerContext: context,
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
  run: async ({ payload, context }: { payload: { message: string }; context: Context }) => {
    // Sleep for 1 second
    await new Promise((resolve) => setTimeout(resolve, 1000));

    thisFunctionWillThrow();
  },
});

function thisFunctionWillThrow() {
  throw new Error("This function will throw");
}
