import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";

describe("BoundedTtlCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a live entry within its TTL", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<string>(1_000, 100);
    cache.set("k", "v");
    vi.advanceTimersByTime(500);
    expect(cache.get("k")).toBe("v");
    expect(cache.size).toBe(1);
  });

  it("evicts an expired entry on read instead of letting it linger", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<number>(1_000, 100);
    cache.set("a", 1);
    expect(cache.size).toBe(1);

    vi.advanceTimersByTime(1_001);
    expect(cache.get("a")).toBeUndefined();
    // The previous bug left expired entries in the map until an at-capacity sweep;
    // they must now be removed on read.
    expect(cache.size).toBe(0);
  });

  it("does not evict another entry when updating an existing key at capacity", () => {
    const cache = new BoundedTtlCache<number>(60_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    // Updating an existing key doesn't grow the map, so it must not drop "b".
    cache.set("a", 11);
    expect(cache.get("a")).toBe(11);
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(2);
  });

  it("drops the oldest entry when full of still-live entries", () => {
    const cache = new BoundedTtlCache<number>(60_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // over capacity, none expired -> evict oldest insertion (a)
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });
});
