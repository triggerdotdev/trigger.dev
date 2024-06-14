import { task } from "@trigger.dev/sdk/v3";
import { LogLevel } from "@infisical/sdk";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload) => {
    console.log("Hello, World!", payload, LogLevel.Debug);
  },
});
