import { describe, it, expect } from "vitest";
import {
  createIdempotencyKey,
  getIdempotencyKeyOptions,
  resetIdempotencyKeyCatalog,
} from "./idempotencyKeys.js";

describe("idempotencyKeys metadata retention", () => {
  it("retains key/scope options for every key created in a run, even beyond 1000", async () => {
    const count = 3000;
    const keys: string[] = [];

    for (let i = 0; i < count; i++) {
      const key = await createIdempotencyKey(`item-${i}`, { scope: "global" });
      keys.push(key);
    }

    // The very first key created should still resolve its original options.
    // With a fixed-size LRU catalog (cap 1000), the earliest ~2000 keys are
    // silently evicted and this returns undefined.
    const firstOptions = getIdempotencyKeyOptions(keys[0]!);
    expect(firstOptions).toEqual({ key: "item-0", scope: "global" });

    // Every key should resolve to its own original options.
    for (let i = 0; i < count; i++) {
      const options = getIdempotencyKeyOptions(keys[i]!);
      expect(options, `options missing for key index ${i}`).toEqual({
        key: `item-${i}`,
        scope: "global",
      });
    }
  });

  it("forgets options after the catalog is reset at a run boundary", async () => {
    const key = await createIdempotencyKey("boundary-key", { scope: "global" });
    expect(getIdempotencyKeyOptions(key)).toEqual({ key: "boundary-key", scope: "global" });

    resetIdempotencyKeyCatalog();

    expect(getIdempotencyKeyOptions(key)).toBeUndefined();
  });
});
