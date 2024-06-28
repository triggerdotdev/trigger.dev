import { task } from "@trigger.dev/sdk/v3";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload) => {
    console.log("Hello, World!", payload);
  },
});
