import { describe, expect, it } from "vitest";

import { ExponentialBackoff } from "./backoff.js";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("ExponentialBackoff.execute", () => {
  it("stops retrying once real wall-clock time exceeds maxElapsed", async () => {
    const backoff = new ExponentialBackoff("NoJitter", {
      factor: 0,
      maxRetries: 1000,
      maxElapsed: 0.05,
    });

    let attempts = 0;

    const result = await backoff.execute(async () => {
      attempts++;
      await sleep(15);
      throw new Error("always fails");
    });

    expect(result.success).toBe(false);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(1000);
  });

  it("returns the result when the callback succeeds", async () => {
    const backoff = new ExponentialBackoff("NoJitter", {
      factor: 0,
      maxRetries: 5,
      maxElapsed: 1,
    });

    let attempts = 0;

    const result = await backoff.execute(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("not yet");
      }
      return "ok";
    });

    expect(result).toEqual({ success: true, result: "ok" });
    expect(attempts).toBe(3);
  });

  it("stops at maxRetries when callbacks are fast and keep failing", async () => {
    const backoff = new ExponentialBackoff("NoJitter", {
      factor: 0,
      maxRetries: 3,
      maxElapsed: 60,
    });

    let attempts = 0;

    const result = await backoff.execute(async () => {
      attempts++;
      throw new Error("always fails");
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.cause).toBe("MaxRetries");
    }
    expect(attempts).toBe(4);
  });
});
