import { task, metadata } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const exampleTask = task({
  id: "example",
  run: async (payload: any, { ctx }) => {
    await metadata.set("status", { type: "started", progress: 0.1 });

    await setTimeout(2000);

    await metadata.set("status", { type: "processing", progress: 0.5 });

    await setTimeout(2000);

    await metadata.set("status", { type: "finished", progress: 1.0 });

    return { message: "All good here!" };
  },
});
