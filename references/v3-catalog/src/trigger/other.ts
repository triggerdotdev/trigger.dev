import { task } from "@trigger.dev/sdk/v3";

export const loggingTask = task({
  id: "logging-task-2",
  run: async () => {
    console.log("Hello world");
  },
});
