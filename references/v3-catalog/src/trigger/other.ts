import { task } from "@trigger.dev/sdk/v3";

export const loggingTask = task({
  id: "logging-task-2",
  run: async ({ payload }: { payload: { url: string } }) => {
    console.log("Hello world");
  },
});
