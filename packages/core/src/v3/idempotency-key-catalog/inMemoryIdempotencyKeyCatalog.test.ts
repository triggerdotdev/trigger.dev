import { describe, it, expect } from "vitest";
import { InMemoryIdempotencyKeyCatalog } from "./inMemoryIdempotencyKeyCatalog.js";

describe("InMemoryIdempotencyKeyCatalog", () => {
  it("stores and retrieves options", () => {
    const catalog = new InMemoryIdempotencyKeyCatalog();
    const options = { key: "my-key", scope: "global" as const };

    catalog.registerKeyOptions("hash1", options);

    expect(catalog.getKeyOptions("hash1")).toEqual(options);
  });

  it("returns undefined for non-existent keys", () => {
    const catalog = new InMemoryIdempotencyKeyCatalog();

    expect(catalog.getKeyOptions("non-existent")).toBeUndefined();
  });

  it("updates options when registering the same hash twice", () => {
    const catalog = new InMemoryIdempotencyKeyCatalog();

    catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
    catalog.registerKeyOptions("hash1", { key: "key1-updated", scope: "run" });

    expect(catalog.getKeyOptions("hash1")).toEqual({ key: "key1-updated", scope: "run" });
  });

  it("retains every entry regardless of count (no eviction)", () => {
    const catalog = new InMemoryIdempotencyKeyCatalog();
    const count = 5000;

    for (let i = 0; i < count; i++) {
      catalog.registerKeyOptions(`hash${i}`, { key: `key${i}`, scope: "global" });
    }

    // The very first entry must still be present — nothing is silently evicted.
    expect(catalog.getKeyOptions("hash0")).toEqual({ key: "key0", scope: "global" });
    expect(catalog.getKeyOptions(`hash${count - 1}`)).toEqual({
      key: `key${count - 1}`,
      scope: "global",
    });
  });

  it("clear() removes all entries", () => {
    const catalog = new InMemoryIdempotencyKeyCatalog();

    catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
    catalog.registerKeyOptions("hash2", { key: "key2", scope: "run" });

    catalog.clear();

    expect(catalog.getKeyOptions("hash1")).toBeUndefined();
    expect(catalog.getKeyOptions("hash2")).toBeUndefined();
  });
});
