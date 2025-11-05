import { demoStream } from "@/app/streams";
import { logger, task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export type STREAMS = {
  demo: string;
};

export type PerformanceChunk = {
  timestamp: number; // When the chunk was sent from the task
  chunkIndex: number;
  data: string;
};

export type StreamScenario =
  | "stall"
  | "continuous"
  | "burst"
  | "slow-steady"
  | "markdown"
  | "performance";

export type StreamPayload = {
  scenario?: StreamScenario;
  // Stall scenario options
  stallDurationMs?: number;
  includePing?: boolean;
  // Continuous scenario options
  durationSec?: number;
  intervalMs?: number;
  // Burst scenario options
  burstCount?: number;
  tokensPerBurst?: number;
  burstIntervalMs?: number;
  pauseBetweenBurstsMs?: number;
  // Slow steady scenario options
  durationMin?: number;
  tokenIntervalSec?: number;
  // Markdown scenario options
  tokenDelayMs?: number;
  // Performance scenario options
  chunkCount?: number;
  chunkIntervalMs?: number;
};

export const streamsTask = task({
  id: "streams",
  run: async (payload: StreamPayload = {}, { ctx }) => {
    await setTimeout(1000);

    const scenario = payload.scenario ?? "continuous";
    logger.info("Starting stream scenario", { scenario });

    let generator: AsyncGenerator<string>;
    let scenarioDescription: string;

    switch (scenario) {
      case "stall": {
        const stallDurationMs = payload.stallDurationMs ?? 3 * 60 * 1000; // Default 3 minutes
        const includePing = payload.includePing ?? false;
        generator = generateLLMTokenStream(includePing, stallDurationMs);
        scenarioDescription = `Stall scenario: ${stallDurationMs / 1000}s with ${
          includePing ? "ping tokens" : "no pings"
        }`;
        break;
      }
      case "continuous": {
        const durationSec = payload.durationSec ?? 45;
        const intervalMs = payload.intervalMs ?? 10;
        generator = generateContinuousTokenStream(durationSec, intervalMs);
        scenarioDescription = `Continuous scenario: ${durationSec}s with ${intervalMs}ms intervals`;
        break;
      }
      case "burst": {
        const burstCount = payload.burstCount ?? 10;
        const tokensPerBurst = payload.tokensPerBurst ?? 20;
        const burstIntervalMs = payload.burstIntervalMs ?? 5;
        const pauseBetweenBurstsMs = payload.pauseBetweenBurstsMs ?? 2000;
        generator = generateBurstTokenStream(
          burstCount,
          tokensPerBurst,
          burstIntervalMs,
          pauseBetweenBurstsMs
        );
        scenarioDescription = `Burst scenario: ${burstCount} bursts of ${tokensPerBurst} tokens`;
        break;
      }
      case "slow-steady": {
        const durationMin = payload.durationMin ?? 5;
        const tokenIntervalSec = payload.tokenIntervalSec ?? 5;
        generator = generateSlowSteadyTokenStream(durationMin, tokenIntervalSec);
        scenarioDescription = `Slow steady scenario: ${durationMin}min with ${tokenIntervalSec}s intervals`;
        break;
      }
      case "markdown": {
        const tokenDelayMs = payload.tokenDelayMs ?? 15;
        generator = generateMarkdownTokenStream(tokenDelayMs);
        scenarioDescription = `Markdown scenario: generating formatted content with ${tokenDelayMs}ms delays`;
        break;
      }
      case "performance": {
        const chunkCount = payload.chunkCount ?? 500;
        const chunkIntervalMs = payload.chunkIntervalMs ?? 10;
        generator = generatePerformanceStream(chunkCount, chunkIntervalMs);
        scenarioDescription = `Performance scenario: ${chunkCount} chunks with ${chunkIntervalMs}ms intervals`;
        break;
      }
      default: {
        throw new Error(`Unknown scenario: ${scenario}`);
      }
    }

    logger.info("Starting stream", { scenarioDescription });

    const mockStream = createStreamFromGenerator(generator);

    const { waitUntilComplete } = demoStream.pipe(mockStream);

    await waitUntilComplete();

    // await demoStream.append(JSON.stringify({ complete: true }));

    // demoStream.writer({
    //   execute: ({ write, merge }) => {
    //     write(JSON.stringify({ step: "one" }));
    //     write(JSON.stringify({ step: "two" }));
    //     write(JSON.stringify({ step: "three" }));
    //     merge(
    //       new ReadableStream({
    //         start(controller) {
    //           controller.enqueue(JSON.stringify({ step: "four" }));
    //           controller.enqueue(JSON.stringify({ step: "five" }));
    //           controller.close();
    //         },
    //       })
    //     );
    //   },
    // });

    logger.info("Stream completed", { scenario });

    return {
      scenario,
      scenarioDescription,
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

// Continuous stream: emit tokens at regular intervals for a specified duration
async function* generateContinuousTokenStream(durationSec: number, intervalMs: number) {
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
    "streaming",
    "tokens",
    "continuously",
    "at",
    "regular",
    "intervals",
    "to",
    "test",
    "real-time",
    "data",
    "flow",
  ];

  const endTime = Date.now() + durationSec * 1000;
  let wordIndex = 0;

  while (Date.now() < endTime) {
    await setTimeout(intervalMs);
    yield words[wordIndex % words.length] + " ";
    wordIndex++;
  }

  yield "\n[Stream completed]";
}

// Burst stream: emit rapid bursts of tokens with pauses between bursts
async function* generateBurstTokenStream(
  burstCount: number,
  tokensPerBurst: number,
  burstIntervalMs: number,
  pauseBetweenBurstsMs: number
) {
  const tokens = "abcdefghijklmnopqrstuvwxyz".split("");

  for (let burst = 0; burst < burstCount; burst++) {
    yield `\n[Burst ${burst + 1}/${burstCount}] `;

    // Emit tokens rapidly in this burst
    for (let token = 0; token < tokensPerBurst; token++) {
      await setTimeout(burstIntervalMs);
      yield tokens[token % tokens.length];
    }

    // Pause between bursts (except after the last burst)
    if (burst < burstCount - 1) {
      await setTimeout(pauseBetweenBurstsMs);
    }
  }

  yield "\n[All bursts completed]";
}

// Slow steady stream: emit tokens at longer intervals over many minutes
async function* generateSlowSteadyTokenStream(durationMin: number, tokenIntervalSec: number) {
  const sentences = [
    "This is a slow and steady stream.",
    "Each token arrives after several seconds.",
    "Perfect for testing long-running connections.",
    "The stream maintains a consistent pace.",
    "Patience is key when testing reliability.",
    "Connections should remain stable throughout.",
    "This helps verify timeout handling.",
    "Real-world streams often have variable timing.",
    "Testing edge cases is important.",
    "Almost done with the slow stream test.",
  ];

  const endTime = Date.now() + durationMin * 60 * 1000;
  let sentenceIndex = 0;

  while (Date.now() < endTime) {
    const sentence = sentences[sentenceIndex % sentences.length];
    yield `${sentence} `;

    sentenceIndex++;
    await setTimeout(tokenIntervalSec * 1000);
  }

  yield "\n[Long stream completed successfully]";
}

// Markdown stream: emit realistic markdown content as tokens (8 characters at a time)
async function* generateMarkdownTokenStream(tokenDelayMs: number) {
  const markdownContent =
    "# Streaming Markdown Example\n\n" +
    "This is a demonstration of **streaming markdown** content in real-time. The content is being generated *token by token*, simulating how an LLM might generate formatted text.\n\n" +
    "## Features\n\n" +
    "Here are some key features being tested:\n\n" +
    "- **Bold text** for emphasis\n" +
    "- *Italic text* for subtle highlighting\n" +
    "- `inline code` for technical terms\n" +
    "- [Links](https://trigger.dev) to external resources\n\n" +
    "### Code Examples\n\n" +
    "You can also stream code blocks:\n\n" +
    "```typescript\n" +
    'import { task, metadata } from "@trigger.dev/sdk";\n\n' +
    "export const myTask = task({\n" +
    '  id: "example-task",\n' +
    "  run: async (payload) => {\n" +
    '    const stream = await metadata.stream("output", myStream);\n' +
    "    \n" +
    "    for await (const chunk of stream) {\n" +
    "      console.log(chunk);\n" +
    "    }\n" +
    "    \n" +
    "    return { success: true };\n" +
    "  },\n" +
    "});\n" +
    "```\n\n" +
    "### Lists and Structure\n\n" +
    "Numbered lists work great too:\n\n" +
    "1. First item with important details\n" +
    "2. Second item with more context\n" +
    "3. Third item completing the sequence\n\n" +
    "#### Nested Content\n\n" +
    "> Blockquotes are useful for highlighting important information or quoting external sources.\n\n" +
    "You can combine **_bold and italic_** text, or use ~~strikethrough~~ for corrections.\n\n" +
    "## Technical Details\n\n" +
    "| Feature | Status | Notes |\n" +
    "|---------|--------|-------|\n" +
    "| Streaming | ✓ | Working perfectly |\n" +
    "| Markdown | ✓ | Full support |\n" +
    "| Realtime | ✓ | Sub-second latency |\n\n" +
    "### Conclusion\n\n" +
    "This markdown streaming scenario demonstrates how formatted content can be transmitted in real-time, maintaining proper structure and formatting throughout the stream.\n\n" +
    "---\n\n" +
    "*Generated with Trigger.dev realtime streams* 🚀\n";

  // Stream tokens of 8 characters at a time with 5ms delay
  // Use Array.from() to properly handle Unicode characters
  const CHARACTERS_PER_TOKEN = 8;
  const DELAY_MS = 5;

  const characters = Array.from(markdownContent);

  for (let i = 0; i < characters.length; i += CHARACTERS_PER_TOKEN) {
    await setTimeout(DELAY_MS);
    yield characters.slice(i, i + CHARACTERS_PER_TOKEN).join("");
  }
}

// Performance stream: emit JSON chunks with timestamps for latency measurement
async function* generatePerformanceStream(chunkCount: number, chunkIntervalMs: number) {
  for (let i = 0; i < chunkCount; i++) {
    await setTimeout(chunkIntervalMs);

    const chunk: PerformanceChunk = {
      timestamp: Date.now(),
      chunkIndex: i,
      data: `Chunk ${i + 1}/${chunkCount}`,
    };

    yield JSON.stringify(chunk);
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
