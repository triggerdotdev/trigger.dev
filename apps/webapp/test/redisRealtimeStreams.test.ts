import { redisTest } from "@internal/testcontainers";
import Redis from "ioredis";
import { describe, expect } from "vitest";
import { RedisRealtimeStreams } from "~/services/realtime/redisRealtimeStreams.server.js";

describe("RedisRealtimeStreams", () => {
  redisTest(
    "Should ingest chunks with correct indices and retrieve last chunk index",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_test123";
      const streamId = "test-stream";

      // Create a mock stream with 5 chunks
      const chunks = [
        JSON.stringify({ chunk: 0, data: "chunk 0" }),
        JSON.stringify({ chunk: 1, data: "chunk 1" }),
        JSON.stringify({ chunk: 2, data: "chunk 2" }),
        JSON.stringify({ chunk: 3, data: "chunk 3" }),
        JSON.stringify({ chunk: 4, data: "chunk 4" }),
      ];

      // Create a ReadableStream from the chunks
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      // Ingest the data with default client ID
      const response = await redisRealtimeStreams.ingestData(stream, runId, streamId, "default");

      // Verify response
      expect(response.status).toBe(200);

      // Verify chunks were stored with correct indices
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");

      // Should have 5 chunks (no END_SENTINEL anymore)
      expect(entries.length).toBe(5);

      // Verify each chunk has the correct index
      for (let i = 0; i < 5; i++) {
        const [_id, fields] = entries[i];

        // Find chunkIndex and data fields
        let chunkIndex: number | null = null;
        let data: string | null = null;

        for (let j = 0; j < fields.length; j += 2) {
          if (fields[j] === "chunkIndex") {
            chunkIndex = parseInt(fields[j + 1], 10);
          }
          if (fields[j] === "data") {
            data = fields[j + 1];
          }
        }

        expect(chunkIndex).toBe(i);
        expect(data).toBe(chunks[i] + "\n");
      }

      // Test getLastChunkIndex for the default client
      const lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(
        runId,
        streamId,
        "default"
      );
      expect(lastChunkIndex).toBe(4); // Last chunk should be index 4

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should resume from specified chunk index and skip duplicates",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_test456";
      const streamId = "test-stream-resume";

      // First, ingest chunks 0-2
      const initialChunks = [
        JSON.stringify({ chunk: 0, data: "chunk 0" }),
        JSON.stringify({ chunk: 1, data: "chunk 1" }),
        JSON.stringify({ chunk: 2, data: "chunk 2" }),
      ];

      const encoder = new TextEncoder();
      const initialStream = new ReadableStream({
        start(controller) {
          for (const chunk of initialChunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(initialStream, runId, streamId, "default");

      // Verify we have 3 chunks
      let lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "default");
      expect(lastChunkIndex).toBe(2);

      // Now "resume" from chunk 3 with new chunks (simulating a retry)
      // When client queries server, server says "I have up to chunk 2"
      // So client resumes from chunk 3 onwards
      const resumeChunks = [
        JSON.stringify({ chunk: 3, data: "chunk 3" }), // New
        JSON.stringify({ chunk: 4, data: "chunk 4" }), // New
      ];

      const resumeStream = new ReadableStream({
        start(controller) {
          for (const chunk of resumeChunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      // Resume from chunk 3 (server tells us it already has 0-2)
      await redisRealtimeStreams.ingestData(resumeStream, runId, streamId, "default", 3);

      // Verify we now have 5 chunks total (0, 1, 2, 3, 4)
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");

      expect(entries.length).toBe(5);

      // Verify last chunk index is 4
      lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "default");
      expect(lastChunkIndex).toBe(4);

      // Verify chunk indices are sequential
      for (let i = 0; i < 5; i++) {
        const [_id, fields] = entries[i];

        let chunkIndex: number | null = null;
        for (let j = 0; j < fields.length; j += 2) {
          if (fields[j] === "chunkIndex") {
            chunkIndex = parseInt(fields[j + 1], 10);
          }
        }

        expect(chunkIndex).toBe(i);
      }

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should return -1 for getLastChunkIndex when stream does not exist",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(
        "run_nonexistent",
        "nonexistent-stream",
        "default"
      );

      expect(lastChunkIndex).toBe(-1);
    }
  );

  redisTest(
    "Should correctly stream response data back to consumers",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_stream_test";
      const streamId = "test-stream-response";

      // Ingest some data first
      const chunks = [
        JSON.stringify({ message: "chunk 0" }),
        JSON.stringify({ message: "chunk 1" }),
        JSON.stringify({ message: "chunk 2" }),
      ];

      const encoder = new TextEncoder();
      const ingestStream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(ingestStream, runId, streamId, "default");

      // Now stream the response
      const mockRequest = new Request("http://localhost/test");
      const abortController = new AbortController();

      const response = await redisRealtimeStreams.streamResponse(
        mockRequest,
        runId,
        streamId,
        abortController.signal
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Read the stream
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const receivedData: string[] = [];

      let done = false;
      while (!done && receivedData.length < 3) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;

        if (value) {
          const text = decoder.decode(value);
          // Parse SSE format: "id: ...\ndata: {json}\n\n"
          const events = text.split("\n\n").filter((event) => event.trim());
          for (const event of events) {
            const lines = event.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.substring(6).trim();
                if (data) {
                  receivedData.push(data);
                }
              }
            }
          }
        }
      }

      // Cancel the stream
      abortController.abort();
      reader.releaseLock();

      // Verify we received all chunks
      // Note: LineTransformStream strips newlines, so we don't expect them in output
      expect(receivedData.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(receivedData[i]).toBe(chunks[i]);
      }

      // Cleanup
      await redis.del(`stream:${runId}:${streamId}`);
      await redis.quit();
    }
  );

  redisTest(
    "Should handle empty stream ingestion",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_empty_test";
      const streamId = "empty-stream";

      // Create an empty stream
      const emptyStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const response = await redisRealtimeStreams.ingestData(
        emptyStream,
        runId,
        streamId,
        "default"
      );

      expect(response.status).toBe(200);

      // Should have no entries (empty stream)
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");
      expect(entries.length).toBe(0);

      // getLastChunkIndex should return -1 for empty stream
      const lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(
        runId,
        streamId,
        "default"
      );
      expect(lastChunkIndex).toBe(-1);

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest("Should handle resume from chunk 0", { timeout: 30_000 }, async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const redisRealtimeStreams = new RedisRealtimeStreams({
      redis: redisOptions,
    });

    const runId = "run_resume_zero";
    const streamId = "test-stream-zero";

    const chunks = [
      JSON.stringify({ chunk: 0, data: "chunk 0" }),
      JSON.stringify({ chunk: 1, data: "chunk 1" }),
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk + "\n"));
        }
        controller.close();
      },
    });

    // Explicitly resume from chunk 0 (should write all chunks)
    await redisRealtimeStreams.ingestData(stream, runId, streamId, "default", 0);

    const streamKey = `stream:${runId}:${streamId}`;
    const entries = await redis.xrange(streamKey, "-", "+");

    expect(entries.length).toBe(2);

    // Verify indices start at 0
    for (let i = 0; i < 2; i++) {
      const [_id, fields] = entries[i];
      let chunkIndex: number | null = null;
      for (let j = 0; j < fields.length; j += 2) {
        if (fields[j] === "chunkIndex") {
          chunkIndex = parseInt(fields[j + 1], 10);
        }
      }
      expect(chunkIndex).toBe(i);
    }

    // Cleanup
    await redis.del(streamKey);
    await redis.quit();
  });

  redisTest(
    "Should handle large number of chunks",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_large_test";
      const streamId = "large-stream";
      const chunkCount = 100;

      // Create 100 chunks
      const chunks: string[] = [];
      for (let i = 0; i < chunkCount; i++) {
        chunks.push(JSON.stringify({ chunk: i, data: `chunk ${i}` }));
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(stream, runId, streamId, "default");

      // Verify last chunk index
      const lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(
        runId,
        streamId,
        "default"
      );
      expect(lastChunkIndex).toBe(chunkCount - 1);

      // Verify all chunks stored
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");

      expect(entries.length).toBe(chunkCount);

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should handle streamResponse with legacy data format (backward compatibility)",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_legacy_test";
      const streamId = "legacy-stream";
      const streamKey = `stream:${runId}:${streamId}`;

      // Manually add entries in legacy format (without chunkIndex or clientId fields)
      await redis.xadd(streamKey, "*", "data", "legacy chunk 1\n");
      await redis.xadd(streamKey, "*", "data", "legacy chunk 2\n");

      // Stream the response
      const mockRequest = new Request("http://localhost/test");
      const abortController = new AbortController();

      const response = await redisRealtimeStreams.streamResponse(
        mockRequest,
        runId,
        streamId,
        abortController.signal
      );

      expect(response.status).toBe(200);

      // Read the stream
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const receivedData: string[] = [];

      let done = false;
      while (!done && receivedData.length < 2) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;

        if (value) {
          const text = decoder.decode(value);
          const events = text.split("\n\n").filter((event) => event.trim());
          for (const event of events) {
            const lines = event.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.substring(6).trim();
                if (data) {
                  receivedData.push(data);
                }
              }
            }
          }
        }
      }

      // Cancel the stream
      abortController.abort();
      reader.releaseLock();

      // Verify we received both legacy chunks
      expect(receivedData.length).toBe(2);
      expect(receivedData[0]).toBe("legacy chunk 1");
      expect(receivedData[1]).toBe("legacy chunk 2");

      // getLastChunkIndex should return -1 for legacy format (no chunkIndex field)
      const lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(
        runId,
        streamId,
        "default"
      );
      expect(lastChunkIndex).toBe(-1);

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should handle concurrent ingestion to the same stream",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_concurrent_test";
      const streamId = "concurrent-stream";

      // Create two sets of chunks that will be ingested concurrently
      const chunks1 = [
        JSON.stringify({ source: "A", chunk: 0, data: "A-chunk 0" }),
        JSON.stringify({ source: "A", chunk: 1, data: "A-chunk 1" }),
        JSON.stringify({ source: "A", chunk: 2, data: "A-chunk 2" }),
      ];

      const chunks2 = [
        JSON.stringify({ source: "B", chunk: 0, data: "B-chunk 0" }),
        JSON.stringify({ source: "B", chunk: 1, data: "B-chunk 1" }),
        JSON.stringify({ source: "B", chunk: 2, data: "B-chunk 2" }),
      ];

      const encoder = new TextEncoder();

      // Create two streams
      const stream1 = new ReadableStream({
        start(controller) {
          for (const chunk of chunks1) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      const stream2 = new ReadableStream({
        start(controller) {
          for (const chunk of chunks2) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      // Ingest both streams concurrently - both starting from chunk 0
      // Note: Using the same clientId will cause duplicate chunk indices (not recommended in practice)
      const [response1, response2] = await Promise.all([
        redisRealtimeStreams.ingestData(stream1, runId, streamId, "default", 0),
        redisRealtimeStreams.ingestData(stream2, runId, streamId, "default", 0),
      ]);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // Verify both sets of chunks were stored
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");

      // Should have 6 total chunks (3 from each stream)
      expect(entries.length).toBe(6);

      // Verify we have chunks from both sources (though order may be interleaved)
      const sourceACounts = entries.filter(([_id, fields]) => {
        for (let j = 0; j < fields.length; j += 2) {
          if (fields[j] === "data" && fields[j + 1].includes('"source":"A"')) {
            return true;
          }
        }
        return false;
      });

      const sourceBCounts = entries.filter(([_id, fields]) => {
        for (let j = 0; j < fields.length; j += 2) {
          if (fields[j] === "data" && fields[j + 1].includes('"source":"B"')) {
            return true;
          }
        }
        return false;
      });

      expect(sourceACounts.length).toBe(3);
      expect(sourceBCounts.length).toBe(3);

      // Note: Both streams write chunks 0, 1, 2, so we'll have duplicate indices
      // This is expected behavior - the last-write-wins with Redis XADD

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should handle concurrent ingestion with different clients and resume points",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_concurrent_resume_test";
      const streamId = "concurrent-resume-stream";

      // Client A writes initial chunks 0-2
      const clientAInitial = [
        JSON.stringify({ client: "A", phase: "initial", chunk: 0 }),
        JSON.stringify({ client: "A", phase: "initial", chunk: 1 }),
        JSON.stringify({ client: "A", phase: "initial", chunk: 2 }),
      ];

      const encoder = new TextEncoder();
      const streamA1 = new ReadableStream({
        start(controller) {
          for (const chunk of clientAInitial) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamA1, runId, streamId, "client-A", 0);

      // Client B writes initial chunks 0-1
      const clientBInitial = [
        JSON.stringify({ client: "B", phase: "initial", chunk: 0 }),
        JSON.stringify({ client: "B", phase: "initial", chunk: 1 }),
      ];

      const streamB1 = new ReadableStream({
        start(controller) {
          for (const chunk of clientBInitial) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamB1, runId, streamId, "client-B", 0);

      // Verify each client's initial state
      let lastChunkA = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-A");
      let lastChunkB = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-B");
      expect(lastChunkA).toBe(2);
      expect(lastChunkB).toBe(1);

      // Now both clients resume concurrently from their own resume points
      const clientAResume = [
        JSON.stringify({ client: "A", phase: "resume", chunk: 3 }),
        JSON.stringify({ client: "A", phase: "resume", chunk: 4 }),
      ];

      const clientBResume = [
        JSON.stringify({ client: "B", phase: "resume", chunk: 2 }),
        JSON.stringify({ client: "B", phase: "resume", chunk: 3 }),
      ];

      const streamA2 = new ReadableStream({
        start(controller) {
          for (const chunk of clientAResume) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      const streamB2 = new ReadableStream({
        start(controller) {
          for (const chunk of clientBResume) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      // Both resume concurrently from their own points
      const [response1, response2] = await Promise.all([
        redisRealtimeStreams.ingestData(streamA2, runId, streamId, "client-A", 3),
        redisRealtimeStreams.ingestData(streamB2, runId, streamId, "client-B", 2),
      ]);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // Verify each client's final state
      lastChunkA = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-A");
      lastChunkB = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-B");

      expect(lastChunkA).toBe(4); // Client A: chunks 0-4
      expect(lastChunkB).toBe(3); // Client B: chunks 0-3

      // Verify total chunks in stream
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");

      // 5 from client A (0-4) + 4 from client B (0-3) = 9 total
      expect(entries.length).toBe(9);

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should track chunk indices independently for different clients",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_multi_client_test";
      const streamId = "multi-client-stream";

      // Client A writes chunks 0-2
      const clientAChunks = [
        JSON.stringify({ client: "A", chunk: 0, data: "A0" }),
        JSON.stringify({ client: "A", chunk: 1, data: "A1" }),
        JSON.stringify({ client: "A", chunk: 2, data: "A2" }),
      ];

      const encoder = new TextEncoder();
      const streamA = new ReadableStream({
        start(controller) {
          for (const chunk of clientAChunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamA, runId, streamId, "client-A", 0);

      // Client B writes chunks 0-1
      const clientBChunks = [
        JSON.stringify({ client: "B", chunk: 0, data: "B0" }),
        JSON.stringify({ client: "B", chunk: 1, data: "B1" }),
      ];

      const streamB = new ReadableStream({
        start(controller) {
          for (const chunk of clientBChunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamB, runId, streamId, "client-B", 0);

      // Verify last chunk index for each client independently
      const lastChunkA = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-A");
      const lastChunkB = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-B");

      expect(lastChunkA).toBe(2); // Client A wrote 3 chunks (0-2)
      expect(lastChunkB).toBe(1); // Client B wrote 2 chunks (0-1)

      // Verify total chunks in stream (5 chunks total)
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");

      expect(entries.length).toBe(5);

      // Verify each chunk has correct clientId
      let clientACount = 0;
      let clientBCount = 0;

      for (const [_id, fields] of entries) {
        let clientId: string | null = null;
        for (let j = 0; j < fields.length; j += 2) {
          if (fields[j] === "clientId") {
            clientId = fields[j + 1];
          }
        }

        if (clientId === "client-A") clientACount++;
        if (clientId === "client-B") clientBCount++;
      }

      expect(clientACount).toBe(3);
      expect(clientBCount).toBe(2);

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should handle one client resuming while another client is writing new chunks",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_client_resume_test";
      const streamId = "client-resume-stream";

      // Client A writes initial chunks 0-2
      const clientAInitial = [
        JSON.stringify({ client: "A", chunk: 0 }),
        JSON.stringify({ client: "A", chunk: 1 }),
        JSON.stringify({ client: "A", chunk: 2 }),
      ];

      const encoder = new TextEncoder();
      const streamA1 = new ReadableStream({
        start(controller) {
          for (const chunk of clientAInitial) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamA1, runId, streamId, "client-A", 0);

      // Verify client A's last chunk
      let lastChunkA = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-A");
      expect(lastChunkA).toBe(2);

      // Client B writes chunks 0-1 (different client, independent sequence)
      const clientBChunks = [
        JSON.stringify({ client: "B", chunk: 0 }),
        JSON.stringify({ client: "B", chunk: 1 }),
      ];

      const streamB = new ReadableStream({
        start(controller) {
          for (const chunk of clientBChunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamB, runId, streamId, "client-B", 0);

      // Verify client B's last chunk
      const lastChunkB = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-B");
      expect(lastChunkB).toBe(1);

      // Client A resumes from chunk 3
      const clientAResume = [
        JSON.stringify({ client: "A", chunk: 3 }),
        JSON.stringify({ client: "A", chunk: 4 }),
      ];

      const streamA2 = new ReadableStream({
        start(controller) {
          for (const chunk of clientAResume) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamA2, runId, streamId, "client-A", 3);

      // Verify final state
      lastChunkA = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-A");
      expect(lastChunkA).toBe(4); // Client A now has chunks 0-4

      // Client B's last chunk should be unchanged
      const lastChunkBAfter = await redisRealtimeStreams.getLastChunkIndex(
        runId,
        streamId,
        "client-B"
      );
      expect(lastChunkBAfter).toBe(1); // Still 1

      // Verify stream has chunks from both clients
      const streamKey = `stream:${runId}:${streamId}`;
      const entries = await redis.xrange(streamKey, "-", "+");

      // 5 from client A + 2 from client B = 7 total
      expect(entries.length).toBe(7);

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should return -1 for client that has never written to stream",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_client_not_found_test";
      const streamId = "client-not-found-stream";

      // Client A writes some chunks
      const clientAChunks = [
        JSON.stringify({ client: "A", chunk: 0 }),
        JSON.stringify({ client: "A", chunk: 1 }),
      ];

      const encoder = new TextEncoder();
      const streamA = new ReadableStream({
        start(controller) {
          for (const chunk of clientAChunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(streamA, runId, streamId, "client-A", 0);

      // Client A's last chunk should be 1
      const lastChunkA = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-A");
      expect(lastChunkA).toBe(1);

      // Client B never wrote anything, should return -1
      const lastChunkB = await redisRealtimeStreams.getLastChunkIndex(runId, streamId, "client-B");
      expect(lastChunkB).toBe(-1);

      // Cleanup
      const streamKey = `stream:${runId}:${streamId}`;
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should skip legacy END_SENTINEL entries when reading and finding last chunk",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_backward_compat_test";
      const streamId = "backward-compat-stream";
      const streamKey = `stream:${runId}:${streamId}`;

      // Manually create a stream with mix of new format and legacy END_SENTINEL
      await redis.xadd(
        streamKey,
        "*",
        "clientId",
        "client-A",
        "chunkIndex",
        "0",
        "data",
        "chunk 0\n"
      );
      await redis.xadd(
        streamKey,
        "*",
        "clientId",
        "client-A",
        "chunkIndex",
        "1",
        "data",
        "chunk 1\n"
      );
      await redis.xadd(streamKey, "*", "data", "<<CLOSE_STREAM>>"); // Legacy END_SENTINEL
      await redis.xadd(
        streamKey,
        "*",
        "clientId",
        "client-A",
        "chunkIndex",
        "2",
        "data",
        "chunk 2\n"
      );
      await redis.xadd(streamKey, "*", "data", "<<CLOSE_STREAM>>"); // Another legacy END_SENTINEL

      // getLastChunkIndex should skip END_SENTINELs and find chunk 2
      const lastChunkIndex = await redisRealtimeStreams.getLastChunkIndex(
        runId,
        streamId,
        "client-A"
      );
      expect(lastChunkIndex).toBe(2);

      // streamResponse should skip END_SENTINELs and only return actual data
      const mockRequest = new Request("http://localhost/test");
      const abortController = new AbortController();

      const response = await redisRealtimeStreams.streamResponse(
        mockRequest,
        runId,
        streamId,
        abortController.signal
      );

      expect(response.status).toBe(200);

      // Read the stream
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const receivedData: string[] = [];

      let done = false;
      while (!done && receivedData.length < 3) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;

        if (value) {
          const text = decoder.decode(value);
          const events = text.split("\n\n").filter((event) => event.trim());
          for (const event of events) {
            const lines = event.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.substring(6).trim();
                if (data) {
                  receivedData.push(data);
                }
              }
            }
          }
        }
      }

      // Cancel the stream
      abortController.abort();
      reader.releaseLock();

      // Should receive 3 chunks (END_SENTINELs skipped)
      expect(receivedData.length).toBe(3);
      expect(receivedData[0]).toBe("chunk 0");
      expect(receivedData[1]).toBe("chunk 1");
      expect(receivedData[2]).toBe("chunk 2");

      // Cleanup
      await redis.del(streamKey);
      await redis.quit();
    }
  );

  redisTest(
    "Should close stream after inactivity timeout",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
        inactivityTimeoutMs: 2000, // 2 seconds for faster test
      });

      const runId = "run_inactivity_test";
      const streamId = "inactivity-stream";

      // Write 2 chunks
      const chunks = [JSON.stringify({ chunk: 0 }), JSON.stringify({ chunk: 1 })];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(stream, runId, streamId, "default");

      // Start streaming
      const mockRequest = new Request("http://localhost/test");
      const abortController = new AbortController();

      const response = await redisRealtimeStreams.streamResponse(
        mockRequest,
        runId,
        streamId,
        abortController.signal
      );

      expect(response.status).toBe(200);

      // Read the stream
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const receivedData: string[] = [];

      const startTime = Date.now();
      let streamClosed = false;

      try {
        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            streamClosed = true;
            break;
          }

          if (value) {
            const text = decoder.decode(value);
            const events = text.split("\n\n").filter((event) => event.trim());
            for (const event of events) {
              const lines = event.split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const data = line.substring(6).trim();
                  if (data) {
                    receivedData.push(data);
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        // Expected to eventually close
      } finally {
        reader.releaseLock();
      }

      const elapsedMs = Date.now() - startTime;

      // Verify stream closed naturally
      expect(streamClosed).toBe(true);

      // Should have received both chunks
      expect(receivedData.length).toBe(2);

      // Should have closed after inactivity timeout + one BLOCK cycle
      // BLOCK time is 5000ms, so minimum time is ~5s (one full BLOCK timeout)
      // The inactivity is checked AFTER the BLOCK returns
      expect(elapsedMs).toBeGreaterThan(4000); // At least one BLOCK cycle
      expect(elapsedMs).toBeLessThan(8000); // But not more than 2 cycles

      // Cleanup
      await redis.del(`stream:${runId}:${streamId}`);
      await redis.quit();
    }
  );

  redisTest(
    "Should format response with event IDs from Redis stream",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_event_id_test";
      const streamId = "event-id-stream";

      // Ingest some data with specific clientId
      const chunks = [
        JSON.stringify({ message: "chunk 0" }),
        JSON.stringify({ message: "chunk 1" }),
        JSON.stringify({ message: "chunk 2" }),
      ];

      const encoder = new TextEncoder();
      const ingestStream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(ingestStream, runId, streamId, "test-client-123");

      // Stream the response
      const mockRequest = new Request("http://localhost/test");
      const abortController = new AbortController();

      const response = await redisRealtimeStreams.streamResponse(
        mockRequest,
        runId,
        streamId,
        abortController.signal
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Read the stream
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const receivedEvents: Array<{ id: string; data: string }> = [];

      let done = false;
      while (!done && receivedEvents.length < 3) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;

        if (value) {
          const text = decoder.decode(value);
          // Split by double newline to get individual events
          const events = text.split("\n\n").filter((event) => event.trim());

          for (const event of events) {
            const lines = event.split("\n");
            let id: string | null = null;
            let data: string | null = null;

            for (const line of lines) {
              if (line.startsWith("id: ")) {
                id = line.substring(4);
              } else if (line.startsWith("data: ")) {
                data = line.substring(6);
              }
            }

            if (id && data) {
              receivedEvents.push({ id, data });
            }
          }
        }
      }

      // Cancel the stream
      abortController.abort();
      reader.releaseLock();

      // Verify we received all chunks with correct event IDs
      expect(receivedEvents.length).toBe(3);

      // Verify event IDs are Redis stream IDs (format: timestamp-sequence like "1234567890123-0")
      for (let i = 0; i < 3; i++) {
        expect(receivedEvents[i].id).toMatch(/^\d+-\d+$/);
        expect(receivedEvents[i].data).toBe(chunks[i]);
      }

      // Verify IDs are in order (each ID should be > previous)
      expect(receivedEvents[1].id > receivedEvents[0].id).toBe(true);
      expect(receivedEvents[2].id > receivedEvents[1].id).toBe(true);

      // Cleanup
      await redis.del(`stream:${runId}:${streamId}`);
      await redis.quit();
    }
  );

  redisTest(
    "Should support resuming from Last-Event-ID",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const redisRealtimeStreams = new RedisRealtimeStreams({
        redis: redisOptions,
      });

      const runId = "run_resume_test";
      const streamId = "resume-stream";

      // Ingest data in two batches
      const firstBatch = [
        JSON.stringify({ batch: 1, chunk: 0 }),
        JSON.stringify({ batch: 1, chunk: 1 }),
        JSON.stringify({ batch: 1, chunk: 2 }),
      ];

      const encoder = new TextEncoder();
      const firstStream = new ReadableStream({
        start(controller) {
          for (const chunk of firstBatch) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(firstStream, runId, streamId, "client-A");

      // Stream and read first batch
      const mockRequest1 = new Request("http://localhost/test");
      const abortController1 = new AbortController();

      const response1 = await redisRealtimeStreams.streamResponse(
        mockRequest1,
        runId,
        streamId,
        abortController1.signal
      );

      expect(response1.status).toBe(200);

      const reader1 = response1.body!.getReader();
      const decoder1 = new TextDecoder();
      const firstEvents: Array<{ id: string; data: string }> = [];

      let done1 = false;
      while (!done1 && firstEvents.length < 3) {
        const { value, done: streamDone } = await reader1.read();
        done1 = streamDone;

        if (value) {
          const text = decoder1.decode(value);
          const events = text.split("\n\n").filter((event) => event.trim());

          for (const event of events) {
            const lines = event.split("\n");
            let id: string | null = null;
            let data: string | null = null;

            for (const line of lines) {
              if (line.startsWith("id: ")) {
                id = line.substring(4);
              } else if (line.startsWith("data: ")) {
                data = line.substring(6);
              }
            }

            if (id && data) {
              firstEvents.push({ id, data });
            }
          }
        }
      }

      abortController1.abort();
      reader1.releaseLock();

      expect(firstEvents.length).toBe(3);
      const lastEventId = firstEvents[firstEvents.length - 1].id;

      // Ingest second batch
      const secondBatch = [
        JSON.stringify({ batch: 2, chunk: 0 }),
        JSON.stringify({ batch: 2, chunk: 1 }),
      ];

      const secondStream = new ReadableStream({
        start(controller) {
          for (const chunk of secondBatch) {
            controller.enqueue(encoder.encode(chunk + "\n"));
          }
          controller.close();
        },
      });

      await redisRealtimeStreams.ingestData(secondStream, runId, streamId, "client-A");

      // Resume streaming from lastEventId
      const mockRequest2 = new Request("http://localhost/test");
      const abortController2 = new AbortController();

      const response2 = await redisRealtimeStreams.streamResponse(
        mockRequest2,
        runId,
        streamId,
        abortController2.signal,
        { lastEventId }
      );

      expect(response2.status).toBe(200);

      const reader2 = response2.body!.getReader();
      const decoder2 = new TextDecoder();
      const resumedEvents: Array<{ id: string; data: string }> = [];

      let done2 = false;
      while (!done2 && resumedEvents.length < 2) {
        const { value, done: streamDone } = await reader2.read();
        done2 = streamDone;

        if (value) {
          const text = decoder2.decode(value);
          const events = text.split("\n\n").filter((event) => event.trim());

          for (const event of events) {
            const lines = event.split("\n");
            let id: string | null = null;
            let data: string | null = null;

            for (const line of lines) {
              if (line.startsWith("id: ")) {
                id = line.substring(4);
              } else if (line.startsWith("data: ")) {
                data = line.substring(6);
              }
            }

            if (id && data) {
              resumedEvents.push({ id, data });
            }
          }
        }
      }

      abortController2.abort();
      reader2.releaseLock();

      // Verify we only received the second batch (events after lastEventId)
      expect(resumedEvents.length).toBe(2);
      expect(resumedEvents[0].data).toBe(secondBatch[0]);
      expect(resumedEvents[1].data).toBe(secondBatch[1]);

      // Verify the resumed events have IDs greater than lastEventId
      expect(resumedEvents[0].id > lastEventId).toBe(true);
      expect(resumedEvents[1].id > lastEventId).toBe(true);

      // Cleanup
      await redis.del(`stream:${runId}:${streamId}`);
      await redis.quit();
    }
  );
});
