import { ApiClient } from "@trigger.dev/core/v3";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import {
  offloadBatchItemPayloads,
  readableStreamToAsyncIterable,
  trigger,
  uniqueBatchTaskIdentifiers,
} from "./shared.js";

describe("uniqueBatchTaskIdentifiers", () => {
  it("returns a stable, deduplicated declaration for batch creation", () => {
    expect(
      uniqueBatchTaskIdentifiers([
        { index: 0, task: "task-b", payload: "{}" },
        { index: 1, task: "task-a", payload: "{}" },
        { index: 2, task: "task-b", payload: "{}" },
      ])
    ).toEqual(["task-a", "task-b"]);
  });
});

describe("offloadBatchItemPayloads", () => {
  // A real client is required for conditionallyExportPacket's truthy check; small payloads
  // short-circuit before any network call, so this never actually reaches the server.
  const apiClient = new ApiClient("http://localhost:3030", "tr_dev_test");

  it("returns an empty array unchanged", async () => {
    expect(await offloadBatchItemPayloads([], apiClient)).toEqual([]);
  });

  it("passes small payloads through and records their pre-offload byte size", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const result = await offloadBatchItemPayloads(
      [{ index: 0, task: "my-task", payload, options: { payloadType: "application/json" } }],
      apiClient
    );
    const item = result[0]!;

    expect(item.payload).toBe(payload);
    expect(item.options?.payloadType).toBe("application/json");
    expect(item.options?.payloadSize).toBe(Buffer.byteLength(payload, "utf8"));
  });

  it("measures multi-byte payloads by byte length, not character count", async () => {
    const payload = "€€€"; // 3 chars, 9 bytes in UTF-8
    const result = await offloadBatchItemPayloads(
      [{ index: 0, task: "my-task", payload, options: { payloadType: "application/json" } }],
      apiClient
    );

    expect(result[0]!.options?.payloadSize).toBe(9);
  });

  it("leaves an already-offloaded (application/store) item untouched", async () => {
    const item = {
      index: 0,
      task: "my-task",
      payload: "trigger/my-task/123/payload.json",
      options: { payloadType: "application/store" },
    };

    const result = await offloadBatchItemPayloads([item], apiClient);
    expect(result[0]).toEqual(item);
  });

  it("leaves items without a string payload untouched", async () => {
    const item = { index: 0, task: "my-task", options: {} };
    const result = await offloadBatchItemPayloads([item], apiClient);
    expect(result[0]).toEqual(item);
  });
});

describe("offloaded trigger payload paths", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running) {
      running.closeAllConnections?.();
      await new Promise<void>((resolve) => running.close(() => resolve()));
    }
  });

  /**
   * Stand in for the presign route and the object store, recording the packet path
   * the SDK actually puts on the wire.
   */
  const startPacketServer = async (): Promise<{ origin: string; requestedPaths: string[] }> => {
    const requestedPaths: string[] = [];
    let origin = "";

    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", origin);

      if (url.pathname.startsWith("/api/v2/packets/")) {
        const encoded = url.pathname.slice("/api/v2/packets/".length);
        const storagePath = decodeURIComponent(encoded);
        requestedPaths.push(storagePath);

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ presignedUrl: `${origin}/upload`, storagePath }));
        return;
      }

      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "run_test" }));
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    return { origin, requestedPaths };
  };

  const NASTY_TASK_IDS = [
    "/my-task",
    "jobs/my-task",
    "my-task/",
    "a//b",
    "jobs/../x",
    "..",
    "my task",
    "caf\u00e9",
    "\ud800",
  ];

  it("builds a path from generated ids only, whatever the task id is", async () => {
    const { origin, requestedPaths } = await startPacketServer();
    const apiClient = new ApiClient(origin, "tr_dev_test");
    const payload = JSON.stringify({ blob: "x".repeat(200_000) });

    const items = NASTY_TASK_IDS.map((task, index) => ({
      index,
      task,
      payload,
      options: { payloadType: "application/json" },
    }));

    const result = await offloadBatchItemPayloads(items, apiClient);

    expect(requestedPaths).toHaveLength(NASTY_TASK_IDS.length);

    for (const path of requestedPaths) {
      expect(path).toMatch(
        /^trigger\/packet_[123456789abcdefghijkmnopqrstuvwxyz]{21}\/payload\.json$/
      );
      expect(path).not.toContain("%");
    }

    expect(new Set(requestedPaths).size).toBe(NASTY_TASK_IDS.length);
    expect(new Set(result.map((item) => item.payload))).toEqual(new Set(requestedPaths));

    for (const [index, item] of result.entries()) {
      expect(item.options?.payloadType).toBe("application/store");
      expect(item.task).toBe(NASTY_TASK_IDS[index]);
    }
  });

  /**
   * A lone surrogate is excluded here only because the trigger endpoint's own URL
   * builder throws on it. That happens after the payload has been offloaded, so the
   * offload path handles the id fine, as the batch case above shows; the uploaded
   * object is simply orphaned when the trigger call fails.
   */
  const TRIGGERABLE_NASTY_TASK_IDS = NASTY_TASK_IDS.filter((taskId) => taskId !== "\ud800");

  it.each(TRIGGERABLE_NASTY_TASK_IDS)(
    "keeps the task id out of the path for trigger() of %j",
    async (taskId) => {
      const { origin, requestedPaths } = await startPacketServer();

      const handle = await trigger(
        taskId as never,
        { blob: "x".repeat(200_000) } as never,
        undefined,
        { clientConfig: { baseURL: origin, accessToken: "tr_dev_test" } }
      );

      expect(handle.id).toBe("run_test");
      expect(requestedPaths).toHaveLength(1);
      expect(requestedPaths[0]).toMatch(
        /^trigger\/packet_[123456789abcdefghijkmnopqrstuvwxyz]{21}\/payload\.json$/
      );
      expect(requestedPaths[0]).not.toContain("%");
    }
  );
});

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
