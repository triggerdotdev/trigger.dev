import { task } from "@trigger.dev/sdk/v3";

export const myJavascriptTaskESM = task({
  id: "my-javascript-task-esm",
  run: async (payload) => {
    console.log("Hello from JavaScript task in esm!");
  },
});
