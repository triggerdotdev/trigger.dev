import { task } from "@trigger.dev/sdk/v3";

export const simplestTask = task({
  id: "fetch-post-task",
  run: async ({ payload }: { payload: { url: string } }) => {
    const response = await fetch(payload.url, {
      method: "POST",
      body: JSON.stringify({ hello: "world", taskId: "fetch-post-task", foo: "barrrrrrrrrr" }),
    });

    return response.json();
  },
});

export const createJsonHeroDoc = task({
  id: "create-jsonhero-doc",
  run: async ({ payload }: { payload: { title: string; content: any } }) => {
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
          ...payload.content,
        },
        readOnly: true,
      }),
    });

    const json: any = await response.json();

    return json;
  },
});
