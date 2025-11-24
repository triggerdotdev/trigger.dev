import { task, logger, metadata } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export type TaggedTaskPayload = {
  userId: string;
  action: string;
};

export type TaggedTaskOutput = {
  userId: string;
  action: string;
  processedAt: string;
};

export const taggedTask = task({
  id: "tagged-task",
  run: async (payload: TaggedTaskPayload) => {
    logger.info("Starting tagged task", payload);
    
    metadata.set("status", "processing");
    metadata.set("userId", payload.userId);
    metadata.set("action", payload.action);

    // Simulate some work
    const steps = 5;
    for (let i = 0; i < steps; i++) {
      await setTimeout(1000);
      metadata.set("progress", (i + 1) / steps);
      logger.info(`Processing step ${i + 1}/${steps} for user ${payload.userId}`);
    }

    metadata.set("status", "completed");

    const output: TaggedTaskOutput = {
      userId: payload.userId,
      action: payload.action,
      processedAt: new Date().toISOString(),
    };

    logger.info("Tagged task completed", output);

    return output;
  },
});

