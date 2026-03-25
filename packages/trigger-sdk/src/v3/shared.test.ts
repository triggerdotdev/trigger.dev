import { describe, it, expect } from "vitest";
import { readableStreamToAsyncIterable } from "./shared.js";

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

