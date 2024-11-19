import { describe, it, expect } from "vitest";
import {
  AnyRunShape,
  RunSubscription,
  StreamSubscription,
  StreamSubscriptionFactory,
  type RunShapeProvider,
} from "../src/v3/apiClient/runStream.js";
import type { SubscribeRunRawShape } from "../src/v3/schemas/api.js";

// Test implementations
class TestStreamSubscription implements StreamSubscription {
  constructor(private chunks: unknown[]) {}

  async subscribe(onChunk: (chunk: unknown) => Promise<void>): Promise<() => void> {
    for (const chunk of this.chunks) {
      await onChunk(chunk);
    }
    return () => {};
  }
}

class TestStreamSubscriptionFactory implements StreamSubscriptionFactory {
  private streams = new Map<string, unknown[]>();

  setStreamChunks(runId: string, streamKey: string, chunks: unknown[]) {
    this.streams.set(`${runId}:${streamKey}`, chunks);
  }

  createSubscription(runId: string, streamKey: string): StreamSubscription {
    const chunks = this.streams.get(`${runId}:${streamKey}`) ?? [];
    return new TestStreamSubscription(chunks);
  }
}

// Create a real test provider that uses an array of shapes
class TestShapeProvider implements RunShapeProvider {
  private shapes: SubscribeRunRawShape[];
  private unsubscribed = false;

  constructor(shapes: SubscribeRunRawShape[]) {
    this.shapes = shapes;
  }

  async onShape(callback: (shape: SubscribeRunRawShape) => Promise<void>): Promise<() => void> {
    // Process all shapes immediately
    for (const shape of this.shapes) {
      if (this.unsubscribed) break;
      await callback(shape);
    }

    return () => {
      this.unsubscribed = true;
    };
  }
}

// Add this new provider that can emit shapes over time
class DelayedTestShapeProvider implements RunShapeProvider {
  private shapes: SubscribeRunRawShape[];
  private unsubscribed = false;
  private currentShapeIndex = 0;

  constructor(shapes: SubscribeRunRawShape[]) {
    this.shapes = shapes;
  }

  async onShape(callback: (shape: SubscribeRunRawShape) => Promise<void>): Promise<() => void> {
    // Only emit the first shape immediately
    if (this.shapes.length > 0) {
      await callback(this.shapes[this.currentShapeIndex++]!);
    }

    // Set up an interval to emit remaining shapes
    const interval = setInterval(async () => {
      if (this.unsubscribed || this.currentShapeIndex >= this.shapes.length) {
        clearInterval(interval);
        return;
      }
      await callback(this.shapes[this.currentShapeIndex++]!);
    }, 100);

    return () => {
      this.unsubscribed = true;
      clearInterval(interval);
    };
  }
}

describe("RunSubscription", () => {
  it("should handle basic run subscription", async () => {
    const shapes = [
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "test-task",
        status: "COMPLETED_SUCCESSFULLY",
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        number: 1,
        usageDurationMs: 100,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
      },
    ];

    const subscription = new RunSubscription({
      provider: new TestShapeProvider(shapes),
      streamFactory: new TestStreamSubscriptionFactory(),
      closeOnComplete: true,
    });

    const results = await convertAsyncIterableToArray(subscription);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "run_123",
      taskIdentifier: "test-task",
      status: "COMPLETED",
    });
  });

  it("should handle payload and outputs", async () => {
    const shapes: SubscribeRunRawShape[] = [
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "test-task",
        status: "COMPLETED_SUCCESSFULLY",
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        number: 1,
        usageDurationMs: 100,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        payload: JSON.stringify({ test: "payload" }),
        payloadType: "application/json",
        output: JSON.stringify({ test: "output" }),
        outputType: "application/json",
      },
    ];

    const subscription = new RunSubscription({
      provider: new TestShapeProvider(shapes),
      streamFactory: new TestStreamSubscriptionFactory(),
      closeOnComplete: true,
    });

    const results = await convertAsyncIterableToArray(subscription);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "run_123",
      taskIdentifier: "test-task",
      status: "COMPLETED",
      payload: { test: "payload" },
      output: { test: "output" },
    });
  });

  it("should keep stream open when closeOnComplete is false", async () => {
    const shapes: SubscribeRunRawShape[] = [
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "test-task",
        status: "EXECUTING",
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        number: 1,
        usageDurationMs: 100,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
      },
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "test-task",
        status: "COMPLETED_SUCCESSFULLY",
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        number: 1,
        usageDurationMs: 200,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
      },
    ];

    const subscription = new RunSubscription({
      provider: new DelayedTestShapeProvider(shapes),
      streamFactory: new TestStreamSubscriptionFactory(),
      closeOnComplete: false,
    });

    // Collect 2 results
    const results = await collectNResults(subscription, 2);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "run_123",
      taskIdentifier: "test-task",
      status: "EXECUTING",
    });
    expect(results[1]).toMatchObject({
      id: "run_123",
      taskIdentifier: "test-task",
      status: "COMPLETED",
    });
  });

  it("should handle stream data", async () => {
    const streamFactory = new TestStreamSubscriptionFactory();

    // Set up test chunks
    streamFactory.setStreamChunks("run_123", "openai", [
      { id: "chunk1", content: "Hello" },
      { id: "chunk2", content: "World" },
    ]);

    const shapes = [
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "openai-streaming",
        status: "EXECUTING",
        createdAt: new Date(),
        updatedAt: new Date(),
        number: 1,
        usageDurationMs: 100,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        metadata: JSON.stringify({
          $$streams: ["openai"],
        }),
        metadataType: "application/json",
      },
    ];

    const subscription = new RunSubscription({
      provider: new TestShapeProvider(shapes),
      streamFactory,
    });

    const results = await collectNResults(
      subscription.withStreams<{ openai: { id: string; content: string } }>(),
      3 // 1 run + 2 stream chunks
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      type: "run",
      run: { id: "run_123", taskIdentifier: "openai-streaming", status: "EXECUTING" },
    });
    expect(results[1]).toMatchObject({
      type: "openai",
      chunk: { id: "chunk1", content: "Hello" },
      run: { id: "run_123", taskIdentifier: "openai-streaming", status: "EXECUTING" },
    });
    expect(results[2]).toMatchObject({
      type: "openai",
      chunk: { id: "chunk2", content: "World" },
      run: { id: "run_123", taskIdentifier: "openai-streaming", status: "EXECUTING" },
    });
  });

  it("should only create one stream for multiple runs of the same id", async () => {
    const streamFactory = new TestStreamSubscriptionFactory();
    let streamCreationCount = 0;

    // Override createSubscription to count calls
    const originalCreate = streamFactory.createSubscription.bind(streamFactory);
    streamFactory.createSubscription = (runId: string, streamKey: string) => {
      streamCreationCount++;
      return originalCreate(runId, streamKey);
    };

    // Set up test chunks
    streamFactory.setStreamChunks("run_123", "openai", [
      { id: "chunk1", content: "Hello" },
      { id: "chunk2", content: "World" },
    ]);

    const shapes = [
      // First run update
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "openai-streaming",
        status: "EXECUTING",
        createdAt: new Date(),
        updatedAt: new Date(),
        number: 1,
        usageDurationMs: 100,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        metadata: JSON.stringify({
          $$streams: ["openai"],
        }),
        metadataType: "application/json",
      },
      // Second run update with same stream key
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "openai-streaming",
        status: "EXECUTING",
        createdAt: new Date(),
        updatedAt: new Date(),
        number: 1,
        usageDurationMs: 200, // Different to show it's a new update
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        metadata: JSON.stringify({
          $$streams: ["openai"],
        }),
        metadataType: "application/json",
      },
    ];

    const subscription = new RunSubscription({
      provider: new TestShapeProvider(shapes),
      streamFactory,
    });

    const results = await collectNResults(
      subscription.withStreams<{ openai: { id: string; content: string } }>(),
      4 // 2 runs + 2 stream chunks
    );

    // Verify we only created one stream
    expect(streamCreationCount).toBe(1);

    // Verify we got all the expected events
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({
      type: "run",
      run: {
        id: "run_123",
        taskIdentifier: "openai-streaming",
        status: "EXECUTING",
        durationMs: 100,
      },
    });
    expect(results[1]).toMatchObject({
      type: "openai",
      chunk: { id: "chunk1", content: "Hello" },
      run: { id: "run_123", durationMs: 100 },
    });
    expect(results[2]).toMatchObject({
      type: "openai",
      chunk: { id: "chunk2", content: "World" },
      run: { id: "run_123", durationMs: 100 },
    });
    expect(results[3]).toMatchObject({
      type: "run",
      run: {
        id: "run_123",
        taskIdentifier: "openai-streaming",
        status: "EXECUTING",
        durationMs: 200,
      },
    });
  });

  it("should handle multiple streams simultaneously", async () => {
    const streamFactory = new TestStreamSubscriptionFactory();

    // Set up test chunks for two different streams
    streamFactory.setStreamChunks("run_123", "openai", [
      { id: "openai1", content: "Hello" },
      { id: "openai2", content: "World" },
    ]);
    streamFactory.setStreamChunks("run_123", "anthropic", [
      { id: "claude1", message: "Hi" },
      { id: "claude2", message: "There" },
    ]);

    const shapes = [
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "multi-streaming",
        status: "EXECUTING",
        createdAt: new Date(),
        updatedAt: new Date(),
        number: 1,
        usageDurationMs: 100,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        metadata: JSON.stringify({
          $$streams: ["openai", "anthropic"],
        }),
        metadataType: "application/json",
      },
    ];

    const subscription = new RunSubscription({
      provider: new TestShapeProvider(shapes),
      streamFactory,
    });

    const results = await collectNResults(
      subscription.withStreams<{
        openai: { id: string; content: string };
        anthropic: { id: string; message: string };
      }>(),
      5 // 1 run + 2 openai chunks + 2 anthropic chunks
    );

    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      type: "run",
      run: { id: "run_123", taskIdentifier: "multi-streaming", status: "EXECUTING" },
    });

    // Filter and verify openai chunks
    const openaiChunks = results.filter((r) => r.type === "openai");
    expect(openaiChunks).toHaveLength(2);
    expect(openaiChunks[0]).toMatchObject({
      type: "openai",
      chunk: { id: "openai1", content: "Hello" },
      run: { id: "run_123" },
    });
    expect(openaiChunks[1]).toMatchObject({
      type: "openai",
      chunk: { id: "openai2", content: "World" },
      run: { id: "run_123" },
    });

    // Filter and verify anthropic chunks
    const anthropicChunks = results.filter((r) => r.type === "anthropic");
    expect(anthropicChunks).toHaveLength(2);
    expect(anthropicChunks[0]).toMatchObject({
      type: "anthropic",
      chunk: { id: "claude1", message: "Hi" },
      run: { id: "run_123" },
    });
    expect(anthropicChunks[1]).toMatchObject({
      type: "anthropic",
      chunk: { id: "claude2", message: "There" },
      run: { id: "run_123" },
    });
  });

  it("should handle streams that appear in different run updates", async () => {
    const streamFactory = new TestStreamSubscriptionFactory();

    // Set up test chunks for two different streams
    streamFactory.setStreamChunks("run_123", "openai", [
      { id: "openai1", content: "Hello" },
      { id: "openai2", content: "World" },
    ]);
    streamFactory.setStreamChunks("run_123", "anthropic", [
      { id: "claude1", message: "Hi" },
      { id: "claude2", message: "There" },
    ]);

    const shapes = [
      // First run update - only has openai stream
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "multi-streaming",
        status: "EXECUTING",
        createdAt: new Date(),
        updatedAt: new Date(),
        number: 1,
        usageDurationMs: 100,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        metadata: JSON.stringify({
          $$streams: ["openai"],
        }),
        metadataType: "application/json",
      },
      // Second run update - adds anthropic stream
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "multi-streaming",
        status: "EXECUTING",
        createdAt: new Date(),
        updatedAt: new Date(),
        number: 1,
        usageDurationMs: 200,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        metadata: JSON.stringify({
          $$streams: ["openai", "anthropic"],
        }),
        metadataType: "application/json",
      },
      // Final run update - marks as complete
      {
        id: "123",
        friendlyId: "run_123",
        taskIdentifier: "multi-streaming",
        status: "COMPLETED_SUCCESSFULLY",
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        number: 1,
        usageDurationMs: 300,
        costInCents: 0,
        baseCostInCents: 0,
        isTest: false,
        runTags: [],
        metadata: JSON.stringify({
          $$streams: ["openai", "anthropic"],
        }),
        metadataType: "application/json",
      },
    ];

    const subscription = new RunSubscription({
      provider: new TestShapeProvider(shapes),
      streamFactory,
      closeOnComplete: true,
    });

    const results = await collectNResults(
      subscription.withStreams<{
        openai: { id: string; content: string };
        anthropic: { id: string; message: string };
      }>(),
      7 // 3 runs + 2 openai chunks + 2 anthropic chunks
    );

    expect(results).toHaveLength(7);

    // Verify run updates
    const runUpdates = results.filter((r) => r.type === "run");
    expect(runUpdates).toHaveLength(3);
    expect(runUpdates[2]!.run.status).toBe("COMPLETED");

    // Verify openai chunks
    const openaiChunks = results.filter((r) => r.type === "openai");
    expect(openaiChunks).toHaveLength(2);

    // Verify anthropic chunks
    const anthropicChunks = results.filter((r) => r.type === "anthropic");
    expect(anthropicChunks).toHaveLength(2);
  });
});

export async function convertAsyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

async function collectNResults<T>(
  iterable: AsyncIterable<T>,
  count: number,
  timeoutMs: number = 1000
): Promise<T[]> {
  const results: T[] = [];
  const promise = new Promise<T[]>((resolve) => {
    (async () => {
      for await (const result of iterable) {
        results.push(result);
        if (results.length === count) {
          resolve(results);
          break;
        }
      }
    })();
  });

  return Promise.race([
    promise,
    new Promise<T[]>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout waiting for ${count} results after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}
