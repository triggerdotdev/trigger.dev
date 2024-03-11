import { task } from "@trigger.dev/sdk/v3";

export const loggingTask = task({
  id: "logging-task",
  run: async () => {
    console.log("Hello world 9");

    return null;
  },
});
