import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "./withTimeout.server";

describe("withTimeout", () => {
  it("resolves with the promise's value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "test")).resolves.toBe("ok");
  });

  it("rejects with the promise's error when it rejects in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "test")).rejects.toThrow(
      "boom"
    );
  });

  it("rejects with a TimeoutError once the deadline passes", async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 10, "the thing")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(never, 10, "the thing")).rejects.toThrow("the thing timed out");
  });
});
