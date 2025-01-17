import { logger, schemaTask, wait } from "@trigger.dev/sdk/v3";
import { createReadStream, writeFileSync } from "node:fs";
import OpenAI from "openai";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const openaiBatch = schemaTask({
  id: "openai-batch",
  description: "Run a batch of JSONL prompts through OpenAI",
  schema: z.object({
    jsonl: z.string(),
  }),
  run: async ({ jsonl }) => {
    // Write a JSONL file to disk
    writeFileSync("batchinput.jsonl", jsonl);

    const file = await openai.files.create({
      file: createReadStream("batchinput.jsonl"),
      purpose: "batch",
    });

    logger.log("Created file", { file });

    const batch = await openai.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });

    logger.log("Created batch", { batch });

    const completedBatch = await openaiBatchMonitor
      .triggerAndWait({
        batchId: batch.id,
      })
      .unwrap();

    return completedBatch;
  },
});

export const openaiBatchMonitor = schemaTask({
  id: "openai-batch-monitor",
  description: "Monitor the status of an OpenAI batch job",
  schema: z.object({
    batchId: z.string(),
  }),
  run: async ({ batchId }) => {
    logger.log("Monitoring batch", { batchId });

    while (true) {
      const batch = await openai.batches.retrieve(batchId);

      logger.log("Batch status", { batch });

      if (
        batch.status === "failed" ||
        batch.status === "completed" ||
        batch.status === "expired" ||
        batch.status === "cancelled"
      ) {
        logger.log("Batch completed", { batch });

        return batch;
      }

      // Check every 10 seconds
      await wait.for({ seconds: 10 });
    }
  },
});
