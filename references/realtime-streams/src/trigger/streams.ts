import { demoStream } from "@/app/streams";
import { logger, metadata, streams, task } from "@trigger.dev/sdk";
import assert from "assert";
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

    logger.info("Stream completed", { scenario });

    return {
      scenario,
      scenarioDescription,
    };
  },
});

export const streamsChildTask = task({
  id: "streams-child",
  run: async (payload: any, { ctx }) => {
    demoStream.writer({
      execute: ({ write, merge }) => {
        write(JSON.stringify({ step: "one" }));
        write(JSON.stringify({ step: "two" }));
        write(JSON.stringify({ step: "three" }));
        merge(
          new ReadableStream({
            start(controller) {
              controller.enqueue(JSON.stringify({ step: "four" }));
              controller.enqueue(JSON.stringify({ step: "five" }));
              controller.close();
            },
          })
        );
      },
      target: ctx.run.rootTaskRunId,
    });
  },
});

export const streamsTesterTask = task({
  id: "streams-tester",
  run: async (payload: any, { ctx }) => {
    logger.info("Starting multiple source streams tester task");

    await multipleSourceStreamsTesterTask
      .triggerAndWait(
        {},
        {},
        {
          clientConfig: {
            future: {
              v2RealtimeStreams: false,
            },
          },
        }
      )
      .unwrap();

    await multipleSourceStreamsTesterTask
      .triggerAndWait(
        {},
        {},
        {
          clientConfig: {
            future: {
              v2RealtimeStreams: true,
            },
          },
        }
      )
      .unwrap();

    logger.info("✅ Multiple source streams tester tasks completed");

    logger.info("Starting stream append tester task");

    await streamAppendTesterTask
      .triggerAndWait(
        {},
        {},
        {
          clientConfig: {
            future: {
              v2RealtimeStreams: false,
            },
          },
        }
      )
      .unwrap();

    await streamAppendTesterTask
      .triggerAndWait(
        {},
        {},
        {
          clientConfig: {
            future: {
              v2RealtimeStreams: true,
            },
          },
        }
      )
      .unwrap();

    logger.info("✅ Stream append tester task completed");

    logger.info("Starting stream pipe tester task");

    await streamPipeTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: true } } })
      .unwrap();

    logger.info("✅ Stream pipe tester task completed");

    await streamPipeTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: false } } })
      .unwrap();

    logger.info("✅ Stream pipe tester task completed");

    logger.info("Starting stream writer tester task");

    await streamWriterTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: true } } })
      .unwrap();

    logger.info("✅ Stream writer tester task completed");

    await streamWriterTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: false } } })
      .unwrap();

    logger.info("✅ Stream writer tester task completed");

    logger.info("Starting stream wait until tester task");

    await streamWaitUntilTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: true } } })
      .unwrap();

    logger.info("✅ Stream wait until tester task completed");

    await streamWaitUntilTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: false } } })
      .unwrap();

    logger.info("✅ Stream wait until tester task completed");

    logger.info("Starting metadata tester task");

    await metadataTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: true } } })
      .unwrap();

    logger.info("✅ Metadata tester task completed");

    await metadataTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: false } } })
      .unwrap();

    logger.info("✅ Metadata tester task completed");

    logger.info("Starting stream read tester task");

    await streamReadTesterTask
      .triggerAndWait({}, {}, { clientConfig: { future: { v2RealtimeStreams: true } } })
      .unwrap();

    logger.info("✅ Stream read tester task completed");

    logger.info("Starting streams stress tester task");

    await streamsStressTesterTask
      .triggerAndWait(
        { streamsVersion: "v1" },
        {},
        { clientConfig: { future: { v2RealtimeStreams: false } } }
      )
      .unwrap();

    logger.info("✅ Streams stress tester task completed");

    await streamsStressTesterTask
      .triggerAndWait(
        { streamsVersion: "v2" },
        {},
        { clientConfig: { future: { v2RealtimeStreams: true } } }
      )
      .unwrap();

    logger.info("✅ Streams stress tester task completed");

    logger.info("Starting end to end latency tester task");

    await endToEndLatencyTesterTask
      .triggerAndWait(
        { streamsVersion: "v1" },
        {},
        { clientConfig: { future: { v2RealtimeStreams: true } } }
      )
      .unwrap();

    logger.info("✅ End to end latency tester task completed");

    await endToEndLatencyTesterTask
      .triggerAndWait(
        { streamsVersion: "v2" },
        {},
        { clientConfig: { future: { v2RealtimeStreams: false } } }
      )
      .unwrap();

    logger.info("✅ End to end latency tester task completed");

    return {
      message: "Multiple source streams tester tasks completed",
    };
  },
});

const testStream = streams.define<string>({
  id: "test",
});

const multipleSourceStreamsTesterTask = task({
  id: "multiple-source-streams-tester",
  run: async (payload: any, { ctx }) => {
    const stream1 = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("stream 1 chunk 1");
        controller.enqueue("stream 1 chunk 2");
        controller.enqueue("stream 1 chunk 3");
        controller.close();
      },
    });

    const stream2 = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("stream 2 chunk 1");
        controller.enqueue("stream 2 chunk 2");
        controller.enqueue("stream 2 chunk 3");
        controller.close();
      },
    });

    const { waitUntilComplete: waitUntilComplete1, stream: stream1Stream } = streams.pipe(stream1);
    const { waitUntilComplete: waitUntilComplete2, stream: stream2Stream } = streams.pipe(stream2);

    await Promise.all([waitUntilComplete1(), waitUntilComplete2()]);

    const stream1Chunks = await convertReadableStreamToArray(stream1Stream);
    const stream2Chunks = await convertReadableStreamToArray(stream2Stream);

    assert.strictEqual(stream1Chunks.length, 3, "Expected 3 chunks");
    assert.ok(stream1Chunks.includes("stream 1 chunk 1"), "Expected stream 1 chunk 1");
    assert.ok(stream1Chunks.includes("stream 1 chunk 2"), "Expected stream 1 chunk 2");
    assert.ok(stream1Chunks.includes("stream 1 chunk 3"), "Expected stream 1 chunk 3");
    assert.strictEqual(stream2Chunks.length, 3, "Expected 3 chunks");
    assert.ok(stream2Chunks.includes("stream 2 chunk 1"), "Expected stream 2 chunk 1");
    assert.ok(stream2Chunks.includes("stream 2 chunk 2"), "Expected stream 2 chunk 2");
    assert.ok(stream2Chunks.includes("stream 2 chunk 3"), "Expected stream 2 chunk 3");

    const chunks = [];

    for await (const chunk of await streams.read(ctx.run.id, { timeoutInSeconds: 5 })) {
      chunks.push(chunk);
    }

    assert.strictEqual(chunks.length, 6, "Expected 6 chunks");
    assert.ok(chunks.includes("stream 1 chunk 1"), "Expected stream 1 chunk 1");
    assert.ok(chunks.includes("stream 1 chunk 2"), "Expected stream 1 chunk 2");
    assert.ok(chunks.includes("stream 1 chunk 3"), "Expected stream 1 chunk 3");
    assert.ok(chunks.includes("stream 2 chunk 1"), "Expected stream 2 chunk 1");
    assert.ok(chunks.includes("stream 2 chunk 2"), "Expected stream 2 chunk 2");
    assert.ok(chunks.includes("stream 2 chunk 3"), "Expected stream 2 chunk 3");

    return {
      message: "Streams completed",
    };
  },
});

const streamAppendTesterTask = task({
  id: "stream-append-tester",
  run: async (payload: any, { ctx }) => {
    await streams.append("chunk 1");
    await streams.append("chunk 2");
    await streams.append("chunk 3");

    const chunks = [];

    for await (const chunk of await streams.read(ctx.run.id, { timeoutInSeconds: 5 })) {
      chunks.push(chunk);
    }

    assert.strictEqual(chunks.length, 3, "Expected 3 chunks");
    assert.ok(chunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(chunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(chunks.includes("chunk 3"), "Expected chunk 3");

    await streams.append("named", "chunk 1");
    await streams.append("named", "chunk 2");
    await streams.append("named", "chunk 3");

    const namedChunks = [];

    for await (const chunk of await streams.read(ctx.run.id, "named", { timeoutInSeconds: 5 })) {
      namedChunks.push(chunk);
    }

    assert.strictEqual(namedChunks.length, 3, "Expected 3 chunks");
    assert.ok(namedChunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(namedChunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(namedChunks.includes("chunk 3"), "Expected chunk 3");

    await testStream.append("chunk 1");
    await testStream.append("chunk 2");
    await testStream.append("chunk 3");

    const testChunks = [];

    for await (const chunk of await testStream.read(ctx.run.id, { timeoutInSeconds: 5 })) {
      testChunks.push(chunk);
    }

    assert.strictEqual(testChunks.length, 3, "Expected 3 chunks");
    assert.ok(testChunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(testChunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(testChunks.includes("chunk 3"), "Expected chunk 3");

    await streamAppendChildTask.triggerAndWait(
      {},
      {},
      { clientConfig: { future: { v2RealtimeStreams: true } } }
    );

    const childChunks = [];

    for await (const chunk of await streams.read(ctx.run.id, "child", { timeoutInSeconds: 5 })) {
      childChunks.push(chunk);
    }

    assert.strictEqual(childChunks.length, 3, "Expected 3 chunks");
    assert.ok(childChunks.includes("child chunk 1"), "Expected child chunk 1");
    assert.ok(childChunks.includes("child chunk 2"), "Expected child chunk 2");
    assert.ok(childChunks.includes("child chunk 3"), "Expected child chunk 3");

    return {
      message: "Stream append completed",
    };
  },
});

const streamAppendChildTask = task({
  id: "stream-append-child",
  run: async (payload: any, { ctx }) => {
    await streams.append("child", "child chunk 1", { target: ctx.run.parentTaskRunId });
    await streams.append("child", "child chunk 2", { target: "parent" });
    await streams.append("child", "child chunk 3", { target: "parent" });
  },
});

const streamPipeTesterTask = task({
  id: "stream-pipe-tester",
  run: async (payload: any, { ctx }) => {
    const { waitUntilComplete } = streams.pipe(
      new ReadableStream({
        start(controller) {
          controller.enqueue("chunk 1");
          controller.enqueue("chunk 2");
          controller.enqueue("chunk 3");
          controller.close();
        },
      })
    );

    await waitUntilComplete();

    const chunks = [];

    for await (const chunk of await streams.read(ctx.run.id, { timeoutInSeconds: 5 })) {
      chunks.push(chunk);
    }

    assert.strictEqual(chunks.length, 3, "Expected 3 chunks");
    assert.ok(chunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(chunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(chunks.includes("chunk 3"), "Expected chunk 3");

    const { waitUntilComplete: waitUntilComplete2 } = streams.pipe(
      "named",
      new ReadableStream({
        start(controller) {
          controller.enqueue("chunk 1");
          controller.enqueue("chunk 2");
          controller.enqueue("chunk 3");
          controller.close();
        },
      })
    );

    await waitUntilComplete2();

    const namedChunks = [];

    for await (const chunk of await streams.read(ctx.run.id, "named", { timeoutInSeconds: 5 })) {
      namedChunks.push(chunk);
    }

    assert.strictEqual(namedChunks.length, 3, "Expected 3 chunks");
    assert.ok(namedChunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(namedChunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(namedChunks.includes("chunk 3"), "Expected chunk 3");

    const { waitUntilComplete: waitUntilComplete3 } = testStream.pipe(
      new ReadableStream({
        start(controller) {
          controller.enqueue("chunk 1");
          controller.enqueue("chunk 2");
          controller.enqueue("chunk 3");
          controller.close();
        },
      })
    );

    await waitUntilComplete3();

    const testChunks = [];

    for await (const chunk of await testStream.read(ctx.run.id, { timeoutInSeconds: 5 })) {
      testChunks.push(chunk);
    }

    assert.strictEqual(testChunks.length, 3, "Expected 3 chunks");
    assert.ok(testChunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(testChunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(testChunks.includes("chunk 3"), "Expected chunk 3");

    return {
      message: "Stream pipe completed",
    };
  },
});

const streamWriterTesterTask = task({
  id: "stream-writer-tester",
  run: async (payload: any, { ctx }) => {
    const { waitUntilComplete, stream } = streams.writer({
      execute: async ({ write, merge }) => {
        write("chunk 1");
        write("chunk 2");
        write("chunk 3");
      },
    });

    await waitUntilComplete();

    const chunks = [];

    for await (const chunk of await streams.read<string>(ctx.run.id, { timeoutInSeconds: 5 })) {
      chunks.push(chunk);
    }

    assert.strictEqual(chunks.length, 3, "Expected 3 chunks");
    assert.ok(chunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(chunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(chunks.includes("chunk 3"), "Expected chunk 3");

    const { waitUntilComplete: waitUntilComplete2 } = streams.writer("named", {
      execute: async ({ write, merge }) => {
        write("chunk 1");
        write("chunk 2");
        write("chunk 3");
      },
    });

    await waitUntilComplete2();

    const namedChunks = [];

    for await (const chunk of await streams.read(ctx.run.id, "named", { timeoutInSeconds: 5 })) {
      namedChunks.push(chunk);
    }

    assert.strictEqual(namedChunks.length, 3, "Expected 3 chunks");
    assert.ok(namedChunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(namedChunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(namedChunks.includes("chunk 3"), "Expected chunk 3");

    const { waitUntilComplete: waitUntilComplete3 } = testStream.writer({
      execute: async ({ write, merge }) => {
        write("chunk 1");
        write("chunk 2");
        write("chunk 3");
      },
    });

    await waitUntilComplete3();

    const testChunks = [];

    for await (const chunk of await testStream.read(ctx.run.id, { timeoutInSeconds: 5 })) {
      testChunks.push(chunk);
    }

    assert.strictEqual(testChunks.length, 3, "Expected 3 chunks");
    assert.ok(testChunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(testChunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(testChunks.includes("chunk 3"), "Expected chunk 3");

    const { waitUntilComplete: waitUntilComplete4 } = streams.writer("merging", {
      execute: async ({ write, merge }) => {
        merge(
          new ReadableStream({
            start(controller) {
              controller.enqueue("chunk 1");
              controller.enqueue("chunk 2");
              controller.enqueue("chunk 3");
              controller.close();
            },
          })
        );
      },
    });

    await waitUntilComplete4();

    const mergingChunks = [];

    for await (const chunk of await streams.read(ctx.run.id, "merging", { timeoutInSeconds: 5 })) {
      mergingChunks.push(chunk);
    }

    assert.strictEqual(mergingChunks.length, 3, "Expected 3 chunks");
    assert.ok(mergingChunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(mergingChunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(mergingChunks.includes("chunk 3"), "Expected chunk 3");

    return {
      message: "Stream writer completed",
    };
  },
});

const streamWaitUntilTesterTask = task({
  id: "stream-wait-until-tester",
  run: async (payload: any, { ctx }) => {
    const result = await streamWaitUntilTesterChildTask.triggerAndWait(
      {},
      {},
      { clientConfig: { future: { v2RealtimeStreams: true } } }
    );

    const chunks = [];

    for await (const chunk of await streams.read(result.id, { timeoutInSeconds: 5 })) {
      chunks.push(chunk);
    }

    const generator = generateContinuousTokenStream(10, 100);
    const stream = createStreamFromGenerator(generator);

    const expectedChunks = await convertReadableStreamToArray(stream);

    assert.strictEqual(chunks.length, expectedChunks.length, "Expected chunks to be the same");
    assert.deepStrictEqual(chunks, expectedChunks, "Expected chunks to be the same");

    return {
      message: "Stream wait until tester completed",
    };
  },
});

const streamWaitUntilTesterChildTask = task({
  id: "stream-wait-until-tester",
  run: async (payload: any, { ctx }) => {
    const generator = generateContinuousTokenStream(10, 100);
    const stream = createStreamFromGenerator(generator);

    streams.pipe(stream); // This should register with the waitUntil system

    return;
  },
});

const metadataTesterTask = task({
  id: "metadata-tester",
  run: async (payload: { parentId?: string }, { ctx }) => {
    await metadata.stream(
      "default",
      new ReadableStream({
        start(controller) {
          controller.enqueue("chunk 1");
          controller.enqueue("chunk 2");
          controller.enqueue("chunk 3");
          controller.close();
        },
      })
    );

    const chunks = [];

    for await (const chunk of await streams.read(ctx.run.id, "default", { timeoutInSeconds: 5 })) {
      chunks.push(chunk);
    }

    assert.strictEqual(chunks.length, 3, "Expected 3 chunks");
    assert.ok(chunks.includes("chunk 1"), "Expected chunk 1");
    assert.ok(chunks.includes("chunk 2"), "Expected chunk 2");
    assert.ok(chunks.includes("chunk 3"), "Expected chunk 3");

    if (payload.parentId) {
      await metadata.parent.stream(
        "parent",
        new ReadableStream({
          start(controller) {
            controller.enqueue("chunk 1");
            controller.enqueue("chunk 2");
            controller.enqueue("chunk 3");
            controller.close();
          },
        })
      );

      const parentChunks = [];

      for await (const chunk of await streams.read(payload.parentId, "parent", {
        timeoutInSeconds: 5,
      })) {
        parentChunks.push(chunk);
      }

      assert.strictEqual(parentChunks.length, 3, "Expected 3 chunks");
      assert.ok(parentChunks.includes("chunk 1"), "Expected chunk 1");
      assert.ok(parentChunks.includes("chunk 2"), "Expected chunk 2");
      assert.ok(parentChunks.includes("chunk 3"), "Expected chunk 3");
    } else {
      await metadataTesterTask.triggerAndWait(
        { parentId: ctx.run.id },
        {},
        { clientConfig: { future: { v2RealtimeStreams: true } } }
      );
    }
  },
});

const streamReadTesterTask = task({
  id: "stream-read-tester",
  run: async (payload: any, { ctx }) => {
    const { waitUntilComplete } = streams.pipe(
      new ReadableStream({
        start(controller) {
          controller.enqueue("chunk 1");
          controller.enqueue("chunk 2");
          controller.enqueue("chunk 3");
          controller.enqueue("chunk 4");
          controller.enqueue("chunk 5");
          controller.enqueue("chunk 6");
          controller.close();
        },
      })
    );

    await waitUntilComplete();

    const chunks = [];
    for await (const chunk of await streams.read(ctx.run.id, { timeoutInSeconds: 5 })) {
      chunks.push(chunk);
    }

    assert.strictEqual(chunks.length, 6, "Expected 6 chunks");

    // Now read starting from the 4th chunk
    // This only properly works with v2 realtime streams
    const chunks2 = [];
    for await (const chunk of await streams.read(ctx.run.id, {
      timeoutInSeconds: 5,
      startIndex: 3,
    })) {
      chunks2.push(chunk);
    }

    assert.strictEqual(chunks2.length, 3, "Expected 3 chunks");

    return {
      message: "Stream read tester completed",
    };
  },
});

const streamsStressTesterTask = task({
  id: "streams-stress-tester",
  run: async (payload: { streamsVersion: "v1" | "v2" }, { ctx }) => {
    const stream = createStreamFromGenerator(generateContinuousTokenStream(60, 5));

    const { waitUntilComplete } = streams.pipe(stream);

    await waitUntilComplete();

    const chunks = [];

    for await (const chunk of await streams.read(ctx.run.id, { timeoutInSeconds: 10 })) {
      chunks.push(chunk);
    }

    logger.info("Received chunks", {
      chunks: chunks.length,
      streamsVersion: payload.streamsVersion,
    });

    switch (payload.streamsVersion) {
      case "v1": {
        assert.ok(chunks.length < 2000, "Expected less than 2000 chunks");
        break;
      }
      case "v2": {
        assert.ok(chunks.length > 2000, "Expected more than 2000 chunks");
        break;
      }
    }

    return {
      message: "Streams stress tester completed",
    };
  },
});

const endToEndLatencyTesterTask = task({
  id: "end-to-end-latency-tester",
  run: async (payload: any, { ctx }) => {
    console.log(
      `Starting end to end latency tester task for ${payload.streamsVersion} streams version`
    );

    const stream = createStreamFromGenerator(generatePerformanceStream(1000, 10));

    const { waitUntilComplete } = streams.pipe(stream);

    const latencies = [];

    const abortController = new AbortController();

    for await (const chunk of await streams.read(ctx.run.id, {
      timeoutInSeconds: 120,
      signal: abortController.signal,
    })) {
      const performanceChunk = JSON.parse(chunk as any) as PerformanceChunk;

      // Calculate the latency
      const latency = Date.now() - performanceChunk.timestamp;

      latencies.push({ latency, index: performanceChunk.chunkIndex });

      if (latencies.length === 1000) {
        console.log("1000 chunks received, aborting");
        abortController.abort();
      }
    }

    await waitUntilComplete();

    // Calculate the min, max, p50 and p95 latencies
    const minLatency = Math.min(...latencies.map((l) => l.latency));
    const maxLatency = Math.max(...latencies.map((l) => l.latency));
    const p50Latency = latencies.sort((a, b) => a.latency - b.latency)[
      Math.floor(latencies.length * 0.5)
    ];
    const p95Latency = latencies.sort((a, b) => a.latency - b.latency)[
      Math.floor(latencies.length * 0.95)
    ];

    const p50LatencyValue = p50Latency.latency;
    const p95LatencyValue = p95Latency.latency;

    console.log(`Min latency: ${minLatency}ms`);
    console.log(`Max latency: ${maxLatency}ms`);
    console.log(`P50 latency: ${p50LatencyValue}ms`);
    console.log(`P95 latency: ${p95LatencyValue}ms`);

    return {
      message: "End to end latency tester completed",
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

async function convertReadableStreamToArray<TPart>(
  stream: ReadableStream<TPart>
): Promise<TPart[]> {
  const chunks: TPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  reader.releaseLock();
  return chunks;
}
