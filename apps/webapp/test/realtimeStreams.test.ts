import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { RealtimeStreams } from "../app/services/realtimeStreams.server.js";
import { convertArrayToReadableStream, convertResponseSSEStreamToArray } from "./utils/streams.js";

vi.setConfig({ testTimeout: 10_000 }); // 5 seconds

// Mock the logger
vi.mock("./logger.server", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe("RealtimeStreams", () => {
  redisTest("should stream data from producer to consumer", async ({ redis }) => {
    const streams = new RealtimeStreams({ redis: redis.options });
    const runId = "test-run";
    const streamId = "test-stream";

    // Create a stream of test data
    const stream = convertArrayToReadableStream(["chunk1", "chunk2", "chunk3"]).pipeThrough(
      new TextEncoderStream()
    );

    // Start consuming the stream
    const abortController = new AbortController();
    const responsePromise = streams.streamResponse(runId, streamId, abortController.signal);

    // Start ingesting data
    await streams.ingestData(stream, runId, streamId);

    // Get the response and read the stream
    const response = await responsePromise;
    const received = await convertResponseSSEStreamToArray(response);

    expect(received).toEqual(["chunk1", "chunk2", "chunk3"]);
  });

  redisTest("should handle multiple concurrent streams", async ({ redis }) => {
    const streams = new RealtimeStreams({ redis: redis.options });
    const runId = "test-run";

    // Set up two different streams
    const stream1 = convertArrayToReadableStream(["1a", "1b", "1c"]).pipeThrough(
      new TextEncoderStream()
    );
    const stream2 = convertArrayToReadableStream(["2a", "2b", "2c"]).pipeThrough(
      new TextEncoderStream()
    );

    // Start consuming both streams
    const abortController = new AbortController();
    const response1Promise = streams.streamResponse(runId, "stream1", abortController.signal);
    const response2Promise = streams.streamResponse(runId, "stream2", abortController.signal);

    // Ingest data to both streams
    await Promise.all([
      streams.ingestData(stream1, runId, "stream1"),
      streams.ingestData(stream2, runId, "stream2"),
    ]);

    // Get and verify both responses
    const [response1, response2] = await Promise.all([response1Promise, response2Promise]);
    const [received1, received2] = await Promise.all([
      convertResponseSSEStreamToArray(response1),
      convertResponseSSEStreamToArray(response2),
    ]);

    expect(received1).toEqual(["1a", "1b", "1c"]);
    expect(received2).toEqual(["2a", "2b", "2c"]);
  });

  redisTest("should handle early consumer abort", async ({ redis }) => {
    const streams = new RealtimeStreams({ redis: redis.options });
    const runId = "test-run";
    const streamId = "test-stream";

    const stream = convertArrayToReadableStream(["chunk1", "chunk2", "chunk3"]).pipeThrough(
      new TextEncoderStream()
    );

    // Start consuming but abort early
    const abortController = new AbortController();
    const responsePromise = streams.streamResponse(runId, streamId, abortController.signal);

    // Get the response before aborting to ensure stream is properly set up
    const response = await responsePromise;

    // Start reading the stream
    const readPromise = convertResponseSSEStreamToArray(response);

    // Abort after a small delay to ensure everything is set up
    await new Promise((resolve) => setTimeout(resolve, 100));
    abortController.abort();

    // Start ingesting data after abort
    await streams.ingestData(stream, runId, streamId);

    // Verify the stream was terminated
    const received = await readPromise;

    expect(received).toEqual(["chunk1"]);
  });
});
