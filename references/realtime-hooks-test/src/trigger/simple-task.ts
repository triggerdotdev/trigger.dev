import { task, logger, metadata } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export type SimpleTaskPayload = {
  message: string;
  duration?: number;
};

export type SimpleTaskOutput = {
  message: string;
  completedAt: string;
};

export const simpleTask = task({
  id: "simple-task",
  run: async (payload: SimpleTaskPayload) => {
    const duration = payload.duration || 10;
    
    logger.info("Starting simple task", { message: payload.message, duration });
    
    // Update metadata to track progress
    metadata.set("status", "initializing");
    metadata.set("progress", 0);

    await setTimeout(1000);
    metadata.set("status", "processing");
    metadata.set("progress", 0.25);

    // Simulate work
    for (let i = 0; i < duration; i++) {
      await setTimeout(1000);
      const progress = ((i + 1) / duration) * 0.75 + 0.25;
      metadata.set("progress", progress);
      metadata.set("currentStep", i + 1);
      metadata.set("totalSteps", duration);
      
      logger.info(`Processing step ${i + 1}/${duration}`);
    }

    metadata.set("status", "completed");
    metadata.set("progress", 1);

    const output: SimpleTaskOutput = {
      message: `Processed: ${payload.message}`,
      completedAt: new Date().toISOString(),
    };

    logger.info("Simple task completed", output);

    return output;
  },
});

