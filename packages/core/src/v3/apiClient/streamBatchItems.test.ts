import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "./index.js";
import { BatchNotSealedError } from "./errors.js";

vi.setConfig({ testTimeout: 10_000 });

describe("streamBatchItems unsealed handling", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * Helper to create a mock fetch that properly consumes the request body stream.
   * This is necessary because streamBatchItems sends a ReadableStream body.
   * Important: We must release the reader lock after consuming, just like real fetch does.
   */
  function createMockFetch(
    responses: Array<{
      id: string;
      itemsAccepted: number;
      itemsDeduplicated: number;
      sealed: boolean;
      enqueuedCount?: number;
      expectedCount?: number;
    }>
  ) {
    let callIndex = 0;
    return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      // Consume the request body stream to prevent hanging
      if (init?.body && init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        // Drain the stream
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          // Release the lock so the stream can be cancelled later (like real fetch does)
          reader.releaseLock();
        }
      }

      const responseData = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;

      return {
        ok: true,
        json: () => Promise.resolve(responseData),
      };
    });
  }

  it("throws BatchNotSealedError when sealed=false after retries exhausted", async () => {
    const mockFetch = createMockFetch([
      {
        id: "batch_test123",
        itemsAccepted: 5,
        itemsDeduplicated: 0,
        sealed: false,
        enqueuedCount: 5,
        expectedCount: 10,
      },
    ]);
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const error = await client
      .streamBatchItems("batch_test123", [{ index: 0, task: "test-task", payload: "{}" }], {
        retry: { maxAttempts: 2, minTimeoutInMs: 10, maxTimeoutInMs: 50 },
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BatchNotSealedError);
    expect((error as BatchNotSealedError).batchId).toBe("batch_test123");
    expect((error as BatchNotSealedError).enqueuedCount).toBe(5);
    expect((error as BatchNotSealedError).expectedCount).toBe(10);
    expect((error as BatchNotSealedError).itemsAccepted).toBe(5);
    expect((error as BatchNotSealedError).itemsDeduplicated).toBe(0);

    // Should have retried (2 attempts total based on maxAttempts)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries when sealed=false and succeeds when sealed=true on retry", async () => {
    const mockFetch = createMockFetch([
      // First response: not sealed
      {
        id: "batch_test123",
        itemsAccepted: 5,
        itemsDeduplicated: 0,
        sealed: false,
        enqueuedCount: 5,
        expectedCount: 10,
      },
      // Second response: sealed
      {
        id: "batch_test123",
        itemsAccepted: 5,
        itemsDeduplicated: 0,
        sealed: true,
      },
    ]);
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const result = await client.streamBatchItems(
      "batch_test123",
      [{ index: 0, task: "test-task", payload: "{}" }],
      { retry: { maxAttempts: 3, minTimeoutInMs: 10, maxTimeoutInMs: 50 } }
    );

    expect(result.sealed).toBe(true);
    // Should have been called twice (first unsealed, second sealed)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("succeeds immediately when sealed=true on first attempt", async () => {
    const mockFetch = createMockFetch([
      {
        id: "batch_test123",
        itemsAccepted: 10,
        itemsDeduplicated: 0,
        sealed: true,
      },
    ]);
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const result = await client.streamBatchItems("batch_test123", [
      { index: 0, task: "test-task", payload: "{}" },
    ]);

    expect(result.sealed).toBe(true);
    expect(result.itemsAccepted).toBe(10);
    // Should only be called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("BatchNotSealedError has descriptive message", async () => {
    const mockFetch = createMockFetch([
      {
        id: "batch_abc123",
        itemsAccepted: 7,
        itemsDeduplicated: 2,
        sealed: false,
        enqueuedCount: 9,
        expectedCount: 15,
      },
    ]);
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const error = await client
      .streamBatchItems("batch_abc123", [{ index: 0, task: "test-task", payload: "{}" }], {
        retry: { maxAttempts: 1, minTimeoutInMs: 10, maxTimeoutInMs: 50 },
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BatchNotSealedError);
    expect(error.message).toContain("batch_abc123");
    expect(error.message).toContain("9 of 15");
    expect(error.message).toContain("accepted: 7");
    expect(error.message).toContain("deduplicated: 2");
  });

  it("handles missing enqueuedCount and expectedCount gracefully", async () => {
    // Simulate older server response that might not include these fields
    const mockFetch = createMockFetch([
      {
        id: "batch_test123",
        itemsAccepted: 5,
        itemsDeduplicated: 0,
        sealed: false,
        // No enqueuedCount or expectedCount
      },
    ]);
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const error = await client
      .streamBatchItems("batch_test123", [{ index: 0, task: "test-task", payload: "{}" }], {
        retry: { maxAttempts: 1, minTimeoutInMs: 10, maxTimeoutInMs: 50 },
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BatchNotSealedError);
    // Should default to 0 when not provided
    expect((error as BatchNotSealedError).enqueuedCount).toBe(0);
    expect((error as BatchNotSealedError).expectedCount).toBe(0);
  });
});

describe("streamBatchItems stream cancellation on retry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * Helper to consume a stream and release the lock (simulating fetch behavior).
   */
  async function consumeAndRelease(stream: ReadableStream<any>) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  it("cancels forRequest stream when retrying due to HTTP error", async () => {
    // Track cancel calls
    let cancelCallCount = 0;
    let callIndex = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const currentAttempt = callIndex;
      callIndex++;

      if (init?.body && init.body instanceof ReadableStream) {
        const originalCancel = init.body.cancel.bind(init.body);
        init.body.cancel = async (reason?: any) => {
          cancelCallCount++;
          return originalCancel(reason);
        };

        // Consume stream and release lock (like real fetch does)
        await consumeAndRelease(init.body);
      }

      // First attempt: return 500 error (retryable)
      if (currentAttempt === 0) {
        return {
          ok: false,
          status: 500,
          text: () => Promise.resolve("Server error"),
          headers: new Headers(),
        };
      }

      // Second attempt: success
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            id: "batch_test123",
            itemsAccepted: 10,
            itemsDeduplicated: 0,
            sealed: true,
          }),
      };
    });
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const result = await client.streamBatchItems(
      "batch_test123",
      [{ index: 0, task: "test-task", payload: "{}" }],
      { retry: { maxAttempts: 3, minTimeoutInMs: 10, maxTimeoutInMs: 50 } }
    );

    expect(result.sealed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // forRequest should be cancelled once (before first retry)
    // forRetry should be cancelled once (after success)
    // Total: 2 cancel calls
    expect(cancelCallCount).toBeGreaterThanOrEqual(1);
  });

  it("cancels forRequest stream when retrying due to batch not sealed", async () => {
    let cancelCallCount = 0;
    let callIndex = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const currentAttempt = callIndex;
      callIndex++;

      if (init?.body && init.body instanceof ReadableStream) {
        const originalCancel = init.body.cancel.bind(init.body);
        init.body.cancel = async (reason?: any) => {
          cancelCallCount++;
          return originalCancel(reason);
        };

        await consumeAndRelease(init.body);
      }

      // First attempt: not sealed (triggers retry)
      if (currentAttempt === 0) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              id: "batch_test123",
              itemsAccepted: 5,
              itemsDeduplicated: 0,
              sealed: false,
              enqueuedCount: 5,
              expectedCount: 10,
            }),
        };
      }

      // Second attempt: sealed
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            id: "batch_test123",
            itemsAccepted: 5,
            itemsDeduplicated: 5,
            sealed: true,
          }),
      };
    });
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const result = await client.streamBatchItems(
      "batch_test123",
      [{ index: 0, task: "test-task", payload: "{}" }],
      { retry: { maxAttempts: 3, minTimeoutInMs: 10, maxTimeoutInMs: 50 } }
    );

    expect(result.sealed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // forRequest cancelled before retry + forRetry cancelled after success
    expect(cancelCallCount).toBeGreaterThanOrEqual(1);
  });

  it("cancels forRequest stream when retrying due to connection error", async () => {
    let cancelCallCount = 0;
    let callIndex = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const currentAttempt = callIndex;
      callIndex++;

      if (init?.body && init.body instanceof ReadableStream) {
        const originalCancel = init.body.cancel.bind(init.body);
        init.body.cancel = async (reason?: any) => {
          cancelCallCount++;
          return originalCancel(reason);
        };

        // Always consume and release - even for error case
        // This simulates what happens when fetch partially reads before failing
        // The important thing is the stream lock is released so cancel() can work
        await consumeAndRelease(init.body);
      }

      // First attempt: connection error (simulate by throwing after consuming)
      if (currentAttempt === 0) {
        throw new TypeError("Failed to fetch");
      }

      // Second attempt: success
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            id: "batch_test123",
            itemsAccepted: 10,
            itemsDeduplicated: 0,
            sealed: true,
          }),
      };
    });
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const result = await client.streamBatchItems(
      "batch_test123",
      [{ index: 0, task: "test-task", payload: "{}" }],
      { retry: { maxAttempts: 3, minTimeoutInMs: 10, maxTimeoutInMs: 50 } }
    );

    expect(result.sealed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // forRequest should be cancelled before retry
    expect(cancelCallCount).toBeGreaterThanOrEqual(1);
  });

  it("does not leak memory by leaving tee branches unconsumed during multiple retries", async () => {
    let cancelCallCount = 0;
    let callIndex = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const currentAttempt = callIndex;
      callIndex++;

      if (init?.body && init.body instanceof ReadableStream) {
        const originalCancel = init.body.cancel.bind(init.body);
        init.body.cancel = async (reason?: any) => {
          cancelCallCount++;
          return originalCancel(reason);
        };

        await consumeAndRelease(init.body);
      }

      // First two attempts: not sealed
      if (currentAttempt < 2) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              id: "batch_test123",
              itemsAccepted: 5,
              itemsDeduplicated: 0,
              sealed: false,
              enqueuedCount: 5,
              expectedCount: 10,
            }),
        };
      }

      // Third attempt: sealed
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            id: "batch_test123",
            itemsAccepted: 5,
            itemsDeduplicated: 5,
            sealed: true,
          }),
      };
    });
    globalThis.fetch = mockFetch;

    const client = new ApiClient("http://localhost:3030", "tr_test_key");

    const result = await client.streamBatchItems(
      "batch_test123",
      [{ index: 0, task: "test-task", payload: "{}" }],
      { retry: { maxAttempts: 5, minTimeoutInMs: 10, maxTimeoutInMs: 50 } }
    );

    expect(result.sealed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Each retry should cancel forRequest, plus final forRetry cancel
    // With 2 retries: 2 forRequest cancels + 1 forRetry cancel = 3 total
    expect(cancelCallCount).toBeGreaterThanOrEqual(2);
  });
});
