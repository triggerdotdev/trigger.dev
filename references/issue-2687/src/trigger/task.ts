import { task } from "@trigger.dev/sdk/v3";

export const myTask = task({
  id: "issue-2687-task",
  run: async (payload: any) => {
    console.log("Task running with payload:", payload);
    return { message: "Hello World" };
  },
});
