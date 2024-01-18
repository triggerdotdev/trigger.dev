import { task } from "@trigger.dev/sdk/v3";

export const simplestTask = task({
  id: "fetch-post-task",
  run: async ({ payload }: { payload: { url: string } }) => {
    const response = await fetch(payload.url, {
      method: "POST",
      body: JSON.stringify({ hello: "world", taskId: "fetch-post-task" }),
    });

    return response.json();
  },
});
