import { describe, it, expect, afterEach, vi } from "vitest";
import { readableStreamToAsyncIterable } from "./shared.js";

let taskIdCounter = 0;

describe("readableStreamToAsyncIterable", () => {
  it("yields all values from the stream", async () => {
    const values = [1, 2, 3, 4, 5];
    const stream = new ReadableStream<number>({
      start(controller) {
        for (const value of values) {
          controller.enqueue(value);
        }
        controller.close();
      },
    });

    const result: number[] = [];
    for await (const value of readableStreamToAsyncIterable(stream)) {
      result.push(value);
    }

    expect(result).toEqual(values);
  });

  it("cancels the stream when consumer breaks early", async () => {
    let cancelCalled = false;

    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.enqueue(4);
        controller.enqueue(5);
        controller.close();
      },
      cancel() {
        cancelCalled = true;
      },
    });

    const result: number[] = [];
    for await (const value of readableStreamToAsyncIterable(stream)) {
      result.push(value);
      if (value === 2) {
        break; // Early termination
      }
    }

    expect(result).toEqual([1, 2]);
    expect(cancelCalled).toBe(true);
  });

  it("cancels the stream when consumer throws an error", async () => {
    let cancelCalled = false;

    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
      cancel() {
        cancelCalled = true;
      },
    });

    const result: number[] = [];
    const testError = new Error("Test error");

    await expect(async () => {
      for await (const value of readableStreamToAsyncIterable(stream)) {
        result.push(value);
        if (value === 2) {
          throw testError;
        }
      }
    }).rejects.toThrow(testError);

    expect(result).toEqual([1, 2]);
    expect(cancelCalled).toBe(true);
  });

  it("handles stream that produces values asynchronously", async () => {
    const values = ["a", "b", "c"];
    let index = 0;

    const stream = new ReadableStream<string>({
      async pull(controller) {
        if (index < values.length) {
          // Simulate async data production
          await new Promise((resolve) => setTimeout(resolve, 1));
          controller.enqueue(values[index]!);
          index++;
        } else {
          controller.close();
        }
      },
    });

    const result: string[] = [];
    for await (const value of readableStreamToAsyncIterable(stream)) {
      result.push(value);
    }

    expect(result).toEqual(values);
  });

  it("cancels async stream when consumer breaks early", async () => {
    let cancelCalled = false;
    let producedCount = 0;

    const stream = new ReadableStream<number>({
      async pull(controller) {
        // Simulate async data production
        await new Promise((resolve) => setTimeout(resolve, 1));
        producedCount++;
        controller.enqueue(producedCount);
        // Never close - infinite stream
      },
      cancel() {
        cancelCalled = true;
      },
    });

    const result: number[] = [];
    for await (const value of readableStreamToAsyncIterable(stream)) {
      result.push(value);
      if (value >= 3) {
        break;
      }
    }

    expect(result).toEqual([1, 2, 3]);
    expect(cancelCalled).toBe(true);
  });

  it("does not throw when cancelling an already-closed stream", async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.close();
      },
    });

    // Normal iteration should complete without errors
    const result: number[] = [];
    for await (const value of readableStreamToAsyncIterable(stream)) {
      result.push(value);
    }

    expect(result).toEqual([1]);
  });

  it("does not throw when cancelling an errored stream", async () => {
    const streamError = new Error("Stream error");
    let errorIndex = 0;

    const stream = new ReadableStream<number>({
      pull(controller) {
        errorIndex++;
        if (errorIndex <= 2) {
          controller.enqueue(errorIndex);
        } else {
          controller.error(streamError);
        }
      },
    });

    const result: number[] = [];

    // The stream error should propagate
    await expect(async () => {
      for await (const value of readableStreamToAsyncIterable(stream)) {
        result.push(value);
      }
    }).rejects.toThrow(streamError);

    // We should have gotten the values before the error
    expect(result).toEqual([1, 2]);
  });

  it("signals upstream producer to stop via cancel", async () => {
    const producedValues: number[] = [];
    let isProducing = true;

    const stream = new ReadableStream<number>({
      async pull(controller) {
        if (!isProducing) return;

        await new Promise((resolve) => setTimeout(resolve, 5));
        const value = producedValues.length + 1;
        producedValues.push(value);
        controller.enqueue(value);
      },
      cancel() {
        isProducing = false;
      },
    });

    const consumed: number[] = [];
    for await (const value of readableStreamToAsyncIterable(stream)) {
      consumed.push(value);
      if (value >= 2) {
        break;
      }
    }

    // Wait a bit to ensure no more values are produced
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(consumed).toEqual([1, 2]);
    // Producer should have stopped after cancel
    expect(isProducing).toBe(false);
    // No more values should have been produced after breaking
    expect(producedValues.length).toBeLessThanOrEqual(3);
  });
});

describe("batchTriggerAndWait debounce forwarding", () => {
  afterEach(() => {
    vi.doUnmock("@trigger.dev/core/v3");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function setupBatchTriggerAndWaitHarness() {
    vi.resetModules();

    const capturedItems: any[] = [];

    const createBatch = vi.fn(async ({ runCount }: { runCount: number }) => ({
      id: "batch_test123",
      runCount,
      publicAccessToken: "access_token",
      isCached: false,
    }));

    const streamBatchItems = vi.fn(async (_batchId: string, items: any[]) => {
      capturedItems.push(...items);

      return {
        id: "batch_test123",
        itemsAccepted: items.length,
        itemsDeduplicated: 0,
        sealed: true,
      };
    });

    const waitForBatch = vi.fn(async ({ id }: { id: string }) => ({
      id,
      items: [],
    }));

    vi.doMock("@trigger.dev/core/v3", async (importOriginal) => {
      const original = await importOriginal<typeof import("@trigger.dev/core/v3")>();

      return {
        ...original,
        apiClientManager: {
          clientOrThrow: vi.fn(() => ({
            createBatch,
            streamBatchItems,
          })),
        } as any,
        runtime: {
          ...original.runtime,
          waitForBatch,
        } as any,
        taskContext: {
          ctx: {
            run: {
              id: "run_123",
              isTest: false,
            },
          },
          worker: {
            version: "worker_123",
          },
        } as any,
      };
    });

    const tasksModule = await import("./tasks.js");

    return {
      ...tasksModule,
      capturedItems,
      createBatch,
      streamBatchItems,
      waitForBatch,
    };
  }

  it("forwards per-item debounce for task.batchTriggerAndWait array items", async () => {
    const { task, capturedItems, streamBatchItems, waitForBatch } =
      await setupBatchTriggerAndWaitHarness();
    const debounce = { key: "same-key", delay: "30s", mode: "trailing" as const };
    const taskId = `batch-debounce-task-${++taskIdCounter}`;

    const myTask = task({
      id: taskId,
      run: async (payload: { id: string }) => payload,
    });

    await myTask.batchTriggerAndWait([{ payload: { id: "a" }, options: { debounce } }]);

    expect(streamBatchItems).toHaveBeenCalledTimes(1);
    expect(waitForBatch).toHaveBeenCalledTimes(1);
    expect(capturedItems).toHaveLength(1);
    expect(capturedItems[0]?.task).toBe(taskId);
    expect(capturedItems[0]?.options?.debounce).toEqual(debounce);
  });

  it("forwards per-item debounce for tasks.batchTriggerAndWait array items", async () => {
    const { tasks, capturedItems, streamBatchItems, waitForBatch } =
      await setupBatchTriggerAndWaitHarness();
    const debounce = { key: "same-key", delay: "30s", mode: "trailing" as const };

    await tasks.batchTriggerAndWait("batch-debounce-by-id-task", [
      { payload: { id: "a" }, options: { debounce } },
    ]);

    expect(streamBatchItems).toHaveBeenCalledTimes(1);
    expect(waitForBatch).toHaveBeenCalledTimes(1);
    expect(capturedItems).toHaveLength(1);
    expect(capturedItems[0]?.task).toBe("batch-debounce-by-id-task");
    expect(capturedItems[0]?.options?.debounce).toEqual(debounce);
  });
});
