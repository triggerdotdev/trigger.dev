import { logger, metadata, task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export type STREAMS = {
  stream: string;
};

export const streamsTask = task({
  id: "streams",
  run: async (payload: { stallDurationMs?: number } = {}) => {
    await setTimeout(1000);

    const stallDurationMs = payload.stallDurationMs ?? 3 * 60 * 1000; // Default 3 minutes
    const mockStream1 = createStreamFromGenerator(generateLLMTokenStream(false, stallDurationMs));

    const stream = await metadata.stream("stream", mockStream1);

    for await (const chunk of stream) {
      logger.info("Received chunk", { chunk });
    }

    return {
      message: "Hello, world!",
    };
  },
});

async function* generateLLMTokenStream(
  includePing: boolean = false,
  stallDurationMs: number = 10 * 60 * 1000
) {
  // Simulate initial LLM tokens (faster, like a real LLM)
  const initialTokens = [
    "Hello",
    " there",
    "!",
    " I'm",
    " going",
    " to",
    " tell",
    " you",
    " a",
    " story",
    ".",
    "\n",
    " Once",
    " upon",
    " a",
    " time",
  ];

  // Stream initial tokens with realistic LLM timing
  for (const token of initialTokens) {
    await setTimeout(Math.random() * 10 + 5); // 5-15ms delay
    yield token;
  }

  // "Stall" window - emit a token every 30 seconds
  const stallIntervalMs = 30 * 1000; // 30 seconds
  const stallTokenCount = Math.floor(stallDurationMs / stallIntervalMs);
  logger.info(
    `Entering stall window for ${stallDurationMs}ms (${
      stallDurationMs / 1000 / 60
    } minutes) - emitting ${stallTokenCount} tokens`
  );

  for (let i = 0; i < stallTokenCount; i++) {
    await setTimeout(stallIntervalMs);
    if (includePing) {
      yield "."; // Emit a single period token every 30 seconds
    }
  }

  logger.info("Resuming normal stream after stall window");

  // Continue with more LLM tokens after stall
  const continuationTokens = [
    " there",
    " was",
    " a",
    " developer",
    " who",
    " needed",
    " to",
    " test",
    " streaming",
    ".",
    " They",
    " used",
    " Trigger",
    ".dev",
    " and",
    " it",
    " worked",
    " perfectly",
    "!",
  ];

  for (const token of continuationTokens) {
    await setTimeout(Math.random() * 10 + 5); // 5-15ms delay
    yield token;
  }
}

// Convert to ReadableStream
function createStreamFromGenerator(generator: AsyncGenerator<string>) {
  return new ReadableStream({
    async start(controller) {
      for await (const chunk of generator) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
}
