import { task, logger, metadata } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export type BatchItemPayload = {
  itemId: string;
  value: number;
};

export type BatchItemOutput = {
  itemId: string;
  result: number;
  processedAt: string;
};

export const batchItemTask = task({
  id: "batch-item-task",
  run: async (payload: BatchItemPayload) => {
    logger.info("Processing batch item", payload);
    
    metadata.set("status", "processing");
    metadata.set("itemId", payload.itemId);
    metadata.set("inputValue", payload.value);

    // Simulate processing with varying duration based on value
    const duration = Math.floor(payload.value / 10) + 2; // 2-12 seconds
    
    for (let i = 0; i < duration; i++) {
      await setTimeout(1000);
      metadata.set("progress", (i + 1) / duration);
    }

    metadata.set("status", "completed");

    // Calculate some result
    const result = payload.value * 2;

    const output: BatchItemOutput = {
      itemId: payload.itemId,
      result,
      processedAt: new Date().toISOString(),
    };

    logger.info("Batch item completed", output);

    return output;
  },
});

