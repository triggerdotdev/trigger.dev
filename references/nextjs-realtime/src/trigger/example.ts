import { task, metadata } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const exampleTask = task({
  id: "example",
  run: async (payload: any, { ctx }) => {
    await metadata.set("status", { type: "started" });

    await setTimeout(2000);

    await metadata.set("status", { type: "finnished" });

    return { payload, ctx };
  },
});
