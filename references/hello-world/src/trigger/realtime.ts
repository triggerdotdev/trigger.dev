import { logger, metadata, runs, task } from "@trigger.dev/sdk";
import { helloWorldTask } from "./example.js";
import { setTimeout } from "timers/promises";

export const realtimeByTagsTask = task({
  id: "realtime-by-tags",
  run: async (payload: any, { ctx, signal }) => {
    await helloWorldTask.trigger(
      { hello: "world" },
      {
        tags: ["hello-world", "realtime"],
      }
    );

    const timeoutSignal = AbortSignal.timeout(10000);

    const $signal = AbortSignal.any([signal, timeoutSignal]);

    $signal.addEventListener("abort", () => {
      logger.info("signal aborted");
    });

    for await (const run of runs.subscribeToRunsWithTag(
      "hello-world",
      { createdAt: "2m", skipColumns: ["payload", "output", "number"] },
      { signal: $signal }
    )) {
      logger.info("run", { run });
    }

    return {
      message: "Hello, world!",
    };
  },
});

export const realtimeUpToDateTask = task({
  id: "realtime-up-to-date",
  run: async ({ runId }: { runId?: string }) => {
    if (!runId) {
      const handle = await helloWorldTask.trigger(
        { hello: "world", sleepFor: 1000 },
        {
          tags: ["hello-world", "realtime"],
        }
      );

      runId = handle.id;
    }

    logger.info("runId", { runId });

    for await (const run of runs.subscribeToRun(runId, { stopOnCompletion: true })) {
      logger.info("run", { run });
    }

    return {
      message: "Hello, world!",
    };
  },
});

export const realtimeStreamsTask = task({
  id: "realtime-streams",
  run: async () => {
    const mockStream = createStreamFromGenerator(generateMockData(5 * 60 * 1000));

    const stream = await metadata.stream("mock-data", mockStream);

    for await (const chunk of stream) {
      logger.info("Received chunk", { chunk });
    }

    return {
      message: "Hello, world!",
    };
  },
});

export const realtimeStreamsV2Task = task({
  id: "realtime-streams-v2",
  run: async () => {
    const mockStream1 = createStreamFromGenerator(generateMockData(5 * 60 * 1000));

    await metadata.stream("mock-data", mockStream1);

    await setTimeout(10000); // Offset by 10 seconds

    const mockStream2 = createStreamFromGenerator(generateMockData(5 * 60 * 1000));
    const stream2 = await metadata.stream("mock-data", mockStream2);

    for await (const chunk of stream2) {
      logger.info("Received chunk", { chunk });
    }

    return {
      message: "Hello, world!",
    };
  },
});

async function* generateMockData(durationMs: number = 5 * 60 * 1000) {
  const chunkInterval = 1000;
  const totalChunks = Math.floor(durationMs / chunkInterval);

  for (let i = 0; i < totalChunks; i++) {
    await setTimeout(chunkInterval);

    yield JSON.stringify({
      chunk: i + 1,
      timestamp: new Date().toISOString(),
      data: `Mock data chunk ${i + 1}`,
    }) + "\n";
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
