import { logger, metadata, schemaTask } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";
import { z } from "zod";

export const ExampleTaskPayload = z.object({
  id: z.string(),
  isAdmin: z.boolean().default(false),
});

export const exampleTask = schemaTask({
  id: "example",
  schema: ExampleTaskPayload,
  run: async (payload, { ctx }) => {
    logger.log("Running example task with payload", { payload });

    await metadata.set("status", { type: "started", progress: 0.1 });

    await setTimeout(2000);

    await metadata.set("status", { type: "processing", progress: 0.5 });

    await setTimeout(2000);

    await metadata.set("status", { type: "finished", progress: 1.0 });

    return { message: "All good here!" };
  },
});
