import { describe, expect, it } from "vitest";
import { ExponentialBackoff } from "../src/v3/apps/backoff.js";

describe("ExponentialBackoff", () => {
  it("stops execute retries when callback time exceeds maxElapsed", async () => {
    const backoff = new ExponentialBackoff("NoJitter", {
      factor: 0,
      maxElapsed: 0.01,
      maxRetries: 5,
    });
    const error = new Error("retryable");
    let attempts = 0;

    const result = await backoff.execute(async () => {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw error;
    });

    expect(result).toEqual({
      success: false,
      cause: "Timeout",
      error,
    });
    expect(attempts).toBe(1);
  });
});
