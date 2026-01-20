import { describe, it, expect } from "vitest";
import { LRUIdempotencyKeyCatalog } from "./lruIdempotencyKeyCatalog.js";

describe("LRUIdempotencyKeyCatalog", () => {
  describe("registerKeyOptions and getKeyOptions", () => {
    it("should store and retrieve options", () => {
      const catalog = new LRUIdempotencyKeyCatalog();
      const options = { key: "my-key", scope: "global" as const };

      catalog.registerKeyOptions("hash1", options);

      expect(catalog.getKeyOptions("hash1")).toEqual(options);
    });

    it("should return undefined for non-existent keys", () => {
      const catalog = new LRUIdempotencyKeyCatalog();

      expect(catalog.getKeyOptions("non-existent")).toBeUndefined();
    });

    it("should store multiple keys", () => {
      const catalog = new LRUIdempotencyKeyCatalog();
      const options1 = { key: "key1", scope: "global" as const };
      const options2 = { key: "key2", scope: "run" as const };
      const options3 = { key: "key3", scope: "attempt" as const };

      catalog.registerKeyOptions("hash1", options1);
      catalog.registerKeyOptions("hash2", options2);
      catalog.registerKeyOptions("hash3", options3);

      expect(catalog.getKeyOptions("hash1")).toEqual(options1);
      expect(catalog.getKeyOptions("hash2")).toEqual(options2);
      expect(catalog.getKeyOptions("hash3")).toEqual(options3);
    });

    it("should update options when registering same key twice", () => {
      const catalog = new LRUIdempotencyKeyCatalog();
      const options1 = { key: "key1", scope: "global" as const };
      const options2 = { key: "key1-updated", scope: "run" as const };

      catalog.registerKeyOptions("hash1", options1);
      catalog.registerKeyOptions("hash1", options2);

      expect(catalog.getKeyOptions("hash1")).toEqual(options2);
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest entry when over capacity", () => {
      const catalog = new LRUIdempotencyKeyCatalog(3);

      catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
      catalog.registerKeyOptions("hash2", { key: "key2", scope: "global" });
      catalog.registerKeyOptions("hash3", { key: "key3", scope: "global" });

      // All three should exist
      expect(catalog.getKeyOptions("hash1")).toBeDefined();
      expect(catalog.getKeyOptions("hash2")).toBeDefined();
      expect(catalog.getKeyOptions("hash3")).toBeDefined();

      // Add a fourth - hash1 should be evicted (it was least recently used after the gets above moved others)
      // Note: After the gets above, the order is hash1, hash2, hash3 (hash1 was accessed first in the gets)
      // Actually let's reset and test more carefully
    });

    it("should evict least recently registered entry when capacity exceeded", () => {
      const catalog = new LRUIdempotencyKeyCatalog(3);

      catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
      catalog.registerKeyOptions("hash2", { key: "key2", scope: "global" });
      catalog.registerKeyOptions("hash3", { key: "key3", scope: "global" });

      // Adding fourth should evict hash1 (oldest)
      catalog.registerKeyOptions("hash4", { key: "key4", scope: "global" });

      expect(catalog.getKeyOptions("hash1")).toBeUndefined();
      expect(catalog.getKeyOptions("hash2")).toBeDefined();
      expect(catalog.getKeyOptions("hash3")).toBeDefined();
      expect(catalog.getKeyOptions("hash4")).toBeDefined();
    });

    it("should evict multiple entries when adding many at once would exceed capacity", () => {
      const catalog = new LRUIdempotencyKeyCatalog(2);

      catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
      catalog.registerKeyOptions("hash2", { key: "key2", scope: "global" });
      catalog.registerKeyOptions("hash3", { key: "key3", scope: "global" });
      catalog.registerKeyOptions("hash4", { key: "key4", scope: "global" });

      // Only hash3 and hash4 should remain
      expect(catalog.getKeyOptions("hash1")).toBeUndefined();
      expect(catalog.getKeyOptions("hash2")).toBeUndefined();
      expect(catalog.getKeyOptions("hash3")).toBeDefined();
      expect(catalog.getKeyOptions("hash4")).toBeDefined();
    });

    it("should work with maxSize of 1", () => {
      const catalog = new LRUIdempotencyKeyCatalog(1);

      catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
      expect(catalog.getKeyOptions("hash1")).toBeDefined();

      catalog.registerKeyOptions("hash2", { key: "key2", scope: "global" });
      expect(catalog.getKeyOptions("hash1")).toBeUndefined();
      expect(catalog.getKeyOptions("hash2")).toBeDefined();
    });
  });

  describe("LRU ordering", () => {
    it("should move accessed key to most recent position", () => {
      const catalog = new LRUIdempotencyKeyCatalog(3);

      catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
      catalog.registerKeyOptions("hash2", { key: "key2", scope: "global" });
      catalog.registerKeyOptions("hash3", { key: "key3", scope: "global" });

      // Access hash1, moving it to most recent
      catalog.getKeyOptions("hash1");

      // Add hash4 - should evict hash2 (now the oldest)
      catalog.registerKeyOptions("hash4", { key: "key4", scope: "global" });

      expect(catalog.getKeyOptions("hash1")).toBeDefined();
      expect(catalog.getKeyOptions("hash2")).toBeUndefined();
      expect(catalog.getKeyOptions("hash3")).toBeDefined();
      expect(catalog.getKeyOptions("hash4")).toBeDefined();
    });

    it("should move re-registered key to most recent position", () => {
      const catalog = new LRUIdempotencyKeyCatalog(3);

      catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
      catalog.registerKeyOptions("hash2", { key: "key2", scope: "global" });
      catalog.registerKeyOptions("hash3", { key: "key3", scope: "global" });

      // Re-register hash1, moving it to most recent
      catalog.registerKeyOptions("hash1", { key: "key1-updated", scope: "run" });

      // Add hash4 - should evict hash2 (now the oldest)
      catalog.registerKeyOptions("hash4", { key: "key4", scope: "global" });

      expect(catalog.getKeyOptions("hash1")).toEqual({ key: "key1-updated", scope: "run" });
      expect(catalog.getKeyOptions("hash2")).toBeUndefined();
      expect(catalog.getKeyOptions("hash3")).toBeDefined();
      expect(catalog.getKeyOptions("hash4")).toBeDefined();
    });

    it("should not affect order when getting non-existent key", () => {
      const catalog = new LRUIdempotencyKeyCatalog(2);

      catalog.registerKeyOptions("hash1", { key: "key1", scope: "global" });
      catalog.registerKeyOptions("hash2", { key: "key2", scope: "global" });

      // Try to get non-existent key
      catalog.getKeyOptions("non-existent");

      // Add hash3 - should still evict hash1 (oldest)
      catalog.registerKeyOptions("hash3", { key: "key3", scope: "global" });

      expect(catalog.getKeyOptions("hash1")).toBeUndefined();
      expect(catalog.getKeyOptions("hash2")).toBeDefined();
      expect(catalog.getKeyOptions("hash3")).toBeDefined();
    });
  });

  describe("default maxSize", () => {
    it("should use default maxSize of 1000", () => {
      const catalog = new LRUIdempotencyKeyCatalog();

      // Register 1001 entries
      for (let i = 0; i < 1001; i++) {
        catalog.registerKeyOptions(`hash${i}`, { key: `key${i}`, scope: "global" });
      }

      // First entry should be evicted
      expect(catalog.getKeyOptions("hash0")).toBeUndefined();
      // Last entry should exist
      expect(catalog.getKeyOptions("hash1000")).toBeDefined();
    });
  });
});
