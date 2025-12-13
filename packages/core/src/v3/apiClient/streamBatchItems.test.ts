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
        while (true) {
          const { done } = await reader.read();
          if (done) break;
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
      .streamBatchItems(
        "batch_test123",
        [{ index: 0, task: "test-task", payload: "{}" }],
        { retry: { maxAttempts: 2, minDelay: 10, maxDelay: 50 } }
      )
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
      { retry: { maxAttempts: 3, minDelay: 10, maxDelay: 50 } }
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
      .streamBatchItems(
        "batch_abc123",
        [{ index: 0, task: "test-task", payload: "{}" }],
        { retry: { maxAttempts: 1, minDelay: 10, maxDelay: 50 } }
      )
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
      .streamBatchItems(
        "batch_test123",
        [{ index: 0, task: "test-task", payload: "{}" }],
        { retry: { maxAttempts: 1, minDelay: 10, maxDelay: 50 } }
      )
      .catch((e) => e);

    expect(error).toBeInstanceOf(BatchNotSealedError);
    // Should default to 0 when not provided
    expect((error as BatchNotSealedError).enqueuedCount).toBe(0);
    expect((error as BatchNotSealedError).expectedCount).toBe(0);
  });
});
