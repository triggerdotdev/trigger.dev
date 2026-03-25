import { task, logger, metadata, streams } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";
import { dataStream, textStream } from "./streams";

export type StreamTaskPayload = {
  scenario: "text" | "json" | "mixed";
  count?: number;
};

export type StreamTaskOutput = {
  scenario: string;
  totalChunks: number;
};

export const streamTask = task({
  id: "stream-task",
  run: async (payload: StreamTaskPayload) => {
    const count = payload.count || 20;

    logger.info("Starting stream task", { scenario: payload.scenario, count });

    metadata.set("status", "streaming");
    metadata.set("scenario", payload.scenario);

    switch (payload.scenario) {
      case "text": {
        // Stream text chunks
        const words = [
          "The",
          "quick",
          "brown",
          "fox",
          "jumps",
          "over",
          "the",
          "lazy",
          "dog",
          "while",
          "demonstrating",
          "real-time",
          "streaming",
          "capabilities",
        ];

        for (let i = 0; i < count; i++) {
          await setTimeout(100);
          await textStream.append(words[i % words.length] + " ");
          metadata.set("progress", (i + 1) / count);
        }

        break;
      }

      case "json": {
        // Stream structured data
        for (let i = 0; i < count; i++) {
          await setTimeout(100);
          await dataStream.append({
            step: i + 1,
            data: `Processing item ${i + 1}`,
            timestamp: Date.now(),
          });
          metadata.set("progress", (i + 1) / count);
        }

        break;
      }

      case "mixed": {
        // Stream to both streams
        const words = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];

        for (let i = 0; i < count; i++) {
          await setTimeout(100);

          // Alternate between streams
          if (i % 2 === 0) {
            await textStream.append(words[i % words.length] + " ");
          } else {
            await dataStream.append({
              step: i + 1,
              data: `Data point ${i + 1}`,
              timestamp: Date.now(),
            });
          }

          metadata.set("progress", (i + 1) / count);
        }

        break;
      }
    }

    metadata.set("status", "completed");
    metadata.set("progress", 1);

    const output: StreamTaskOutput = {
      scenario: payload.scenario,
      totalChunks: count,
    };

    logger.info("Stream task completed", output);

    return output;
  },
});
