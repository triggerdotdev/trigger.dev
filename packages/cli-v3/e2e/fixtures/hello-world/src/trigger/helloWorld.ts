import { task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "node:timers/promises";

export const helloWorld = task({
  id: "helloWorld",
  run: async () => {
    await setTimeout(1000);
    console.log("Hello, World!");
  },
});
