import { describe, it, expect, beforeEach, vi } from "vitest";
import { LRUMemoryStore, createLRUMemoryStore } from "./lruMemory.js";
import type { Entry } from "@unkey/cache/stores";

function createEntry<T>(value: T, freshUntil: number, staleUntil: number): Entry<T> {
  return { value, freshUntil, staleUntil };
}

describe("LRUMemoryStore", () => {
  let store: LRUMemoryStore<string, string>;

  beforeEach(() => {
    store = new LRUMemoryStore({ max: 5, name: "test-store" });
  });

  describe("basic operations", () => {
    it("should set and get a value", async () => {
      const entry = createEntry("test-value", Date.now() + 60000, Date.now() + 120000);

      const setResult = await store.set("ns", "key1", entry);
      expect(setResult.err).toBeUndefined();

      const getResult = await store.get("ns", "key1");
      expect(getResult.err).toBeUndefined();
      expect(getResult.val).toEqual(entry);
    });

    it("should return undefined for missing keys", async () => {
      const result = await store.get("ns", "nonexistent");
      expect(result.err).toBeUndefined();
      expect(result.val).toBeUndefined();
    });

    it("should remove a single key", async () => {
      const entry = createEntry("value", Date.now() + 60000, Date.now() + 120000);
      await store.set("ns", "key1", entry);

      const removeResult = await store.remove("ns", "key1");
      expect(removeResult.err).toBeUndefined();

      const getResult = await store.get("ns", "key1");
      expect(getResult.val).toBeUndefined();
    });

    it("should remove multiple keys", async () => {
      const entry = createEntry("value", Date.now() + 60000, Date.now() + 120000);
      await store.set("ns", "key1", entry);
      await store.set("ns", "key2", entry);
      await store.set("ns", "key3", entry);

      const removeResult = await store.remove("ns", ["key1", "key2"]);
      expect(removeResult.err).toBeUndefined();

      expect((await store.get("ns", "key1")).val).toBeUndefined();
      expect((await store.get("ns", "key2")).val).toBeUndefined();
      expect((await store.get("ns", "key3")).val).not.toBeUndefined();
    });
  });

  describe("namespace isolation", () => {
    it("should isolate keys by namespace", async () => {
      const entry1 = createEntry("value1", Date.now() + 60000, Date.now() + 120000);
      const entry2 = createEntry("value2", Date.now() + 60000, Date.now() + 120000);

      await store.set("ns1", "key", entry1);
      await store.set("ns2", "key", entry2);

      const result1 = await store.get("ns1", "key");
      const result2 = await store.get("ns2", "key");

      expect(result1.val?.value).toBe("value1");
      expect(result2.val?.value).toBe("value2");
    });
  });

  describe("TTL expiration", () => {
    it("should return undefined for expired entries (past staleUntil)", async () => {
      const entry = createEntry("value", Date.now() - 2000, Date.now() - 1000); // Already expired

      await store.set("ns", "expired-key", entry);

      const result = await store.get("ns", "expired-key");
      expect(result.val).toBeUndefined();
    });

    it("should return entry that is stale but not expired", async () => {
      const now = Date.now();
      // Fresh until 1 second ago, stale until 1 hour from now
      const entry = createEntry("value", now - 1000, now + 3600000);

      await store.set("ns", "stale-key", entry);

      const result = await store.get("ns", "stale-key");
      expect(result.val).not.toBeUndefined();
      expect(result.val?.value).toBe("value");
    });

    it("should delete expired entry on get", async () => {
      const entry = createEntry("value", Date.now() - 2000, Date.now() - 1000);
      await store.set("ns", "key", entry);

      // First get should return undefined and delete
      await store.get("ns", "key");

      // Size should reflect deletion
      expect(store.size).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    it("should evict least recently used items when at capacity", async () => {
      const entry = (val: string) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      // Fill the cache (max: 5)
      await store.set("ns", "key1", entry("value1"));
      await store.set("ns", "key2", entry("value2"));
      await store.set("ns", "key3", entry("value3"));
      await store.set("ns", "key4", entry("value4"));
      await store.set("ns", "key5", entry("value5"));

      expect(store.size).toBe(5);

      // Add one more - should evict key1 (least recently used)
      await store.set("ns", "key6", entry("value6"));

      expect(store.size).toBe(5);
      expect((await store.get("ns", "key1")).val).toBeUndefined(); // Evicted
      expect((await store.get("ns", "key6")).val?.value).toBe("value6"); // Present
    });

    it("should update LRU order on get", async () => {
      const entry = (val: string) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      // Fill the cache
      await store.set("ns", "key1", entry("value1"));
      await store.set("ns", "key2", entry("value2"));
      await store.set("ns", "key3", entry("value3"));
      await store.set("ns", "key4", entry("value4"));
      await store.set("ns", "key5", entry("value5"));

      // Access key1 to make it recently used
      await store.get("ns", "key1");

      // Add new item - should evict key2 (now least recently used)
      await store.set("ns", "key6", entry("value6"));

      expect((await store.get("ns", "key1")).val?.value).toBe("value1"); // Still present
      expect((await store.get("ns", "key2")).val).toBeUndefined(); // Evicted
    });

    it("should update LRU order on set (update existing)", async () => {
      const entry = (val: string) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      // Fill the cache
      await store.set("ns", "key1", entry("value1"));
      await store.set("ns", "key2", entry("value2"));
      await store.set("ns", "key3", entry("value3"));
      await store.set("ns", "key4", entry("value4"));
      await store.set("ns", "key5", entry("value5"));

      // Update key1 to make it recently used
      await store.set("ns", "key1", entry("updated-value1"));

      // Add new item - should evict key2 (now least recently used)
      await store.set("ns", "key6", entry("value6"));

      expect((await store.get("ns", "key1")).val?.value).toBe("updated-value1");
      expect((await store.get("ns", "key2")).val).toBeUndefined(); // Evicted
    });
  });

  describe("hard limit enforcement", () => {
    it("should never exceed max size regardless of write rate", async () => {
      const smallStore = new LRUMemoryStore<string, number>({ max: 10 });
      const entry = (val: number) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      // Write 1000 items rapidly
      for (let i = 0; i < 1000; i++) {
        await smallStore.set("ns", `key${i}`, entry(i));
        // Verify size never exceeds max
        expect(smallStore.size).toBeLessThanOrEqual(10);
      }

      expect(smallStore.size).toBe(10);
    });

    it("should maintain most recent items when at capacity", async () => {
      const smallStore = new LRUMemoryStore<string, number>({ max: 3 });
      const entry = (val: number) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      // Write items sequentially
      await smallStore.set("ns", "key1", entry(1));
      await smallStore.set("ns", "key2", entry(2));
      await smallStore.set("ns", "key3", entry(3));
      await smallStore.set("ns", "key4", entry(4));
      await smallStore.set("ns", "key5", entry(5));

      // Only the 3 most recent should remain
      expect((await smallStore.get("ns", "key1")).val).toBeUndefined();
      expect((await smallStore.get("ns", "key2")).val).toBeUndefined();
      expect((await smallStore.get("ns", "key3")).val?.value).toBe(3);
      expect((await smallStore.get("ns", "key4")).val?.value).toBe(4);
      expect((await smallStore.get("ns", "key5")).val?.value).toBe(5);
    });
  });

  describe("utility methods", () => {
    it("should report correct size", async () => {
      const entry = createEntry("value", Date.now() + 60000, Date.now() + 120000);

      expect(store.size).toBe(0);

      await store.set("ns", "key1", entry);
      expect(store.size).toBe(1);

      await store.set("ns", "key2", entry);
      expect(store.size).toBe(2);

      await store.remove("ns", "key1");
      expect(store.size).toBe(1);
    });

    it("should clear all items", async () => {
      const entry = createEntry("value", Date.now() + 60000, Date.now() + 120000);

      await store.set("ns1", "key1", entry);
      await store.set("ns2", "key2", entry);
      await store.set("ns3", "key3", entry);

      expect(store.size).toBe(3);

      store.clear();

      expect(store.size).toBe(0);
      expect((await store.get("ns1", "key1")).val).toBeUndefined();
    });

    it("should use custom name", () => {
      const customStore = new LRUMemoryStore({ max: 10, name: "custom-name" });
      expect(customStore.name).toBe("custom-name");
    });

    it("should use default name when not provided", () => {
      const defaultStore = new LRUMemoryStore({ max: 10 });
      expect(defaultStore.name).toBe("lru-memory");
    });
  });

  describe("createLRUMemoryStore helper", () => {
    it("should create a store with specified max size", async () => {
      const helperStore = createLRUMemoryStore(3);
      const entry = (val: number) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      await helperStore.set("ns", "key1", entry(1));
      await helperStore.set("ns", "key2", entry(2));
      await helperStore.set("ns", "key3", entry(3));
      await helperStore.set("ns", "key4", entry(4));

      expect(helperStore.size).toBe(3);
      expect((await helperStore.get("ns", "key1")).val).toBeUndefined();
    });

    it("should accept custom name", () => {
      const namedStore = createLRUMemoryStore(10, "my-cache");
      expect(namedStore.name).toBe("my-cache");
    });
  });

  describe("complex value types", () => {
    it("should handle object values", async () => {
      const objectStore = new LRUMemoryStore<string, { id: number; data: string[] }>({ max: 5 });
      const complexValue = { id: 123, data: ["a", "b", "c"] };
      const entry = createEntry(complexValue, Date.now() + 60000, Date.now() + 120000);

      await objectStore.set("ns", "obj-key", entry);

      const result = await objectStore.get("ns", "obj-key");
      expect(result.val?.value).toEqual(complexValue);
    });

    it("should handle null and undefined values", async () => {
      const nullStore = new LRUMemoryStore<string, null | undefined>({ max: 5 });

      const nullEntry = createEntry(null, Date.now() + 60000, Date.now() + 120000);
      const undefinedEntry = createEntry(undefined, Date.now() + 60000, Date.now() + 120000);

      await nullStore.set("ns", "null-key", nullEntry);
      await nullStore.set("ns", "undefined-key", undefinedEntry);

      expect((await nullStore.get("ns", "null-key")).val?.value).toBeNull();
      expect((await nullStore.get("ns", "undefined-key")).val?.value).toBeUndefined();
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent writes safely", async () => {
      const concurrentStore = new LRUMemoryStore<string, number>({ max: 100 });
      const entry = (val: number) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      // Simulate concurrent writes
      const writes = Array.from({ length: 50 }, (_, i) =>
        concurrentStore.set("ns", `key${i}`, entry(i))
      );

      await Promise.all(writes);

      expect(concurrentStore.size).toBe(50);
    });

    it("should handle concurrent reads and writes", async () => {
      const concurrentStore = new LRUMemoryStore<string, number>({ max: 100 });
      const entry = (val: number) => createEntry(val, Date.now() + 60000, Date.now() + 120000);

      // Pre-populate
      for (let i = 0; i < 50; i++) {
        await concurrentStore.set("ns", `key${i}`, entry(i));
      }

      // Mix of reads and writes
      const operations = [
        ...Array.from({ length: 25 }, (_, i) => concurrentStore.get("ns", `key${i}`)),
        ...Array.from({ length: 25 }, (_, i) =>
          concurrentStore.set("ns", `new-key${i}`, entry(i + 100))
        ),
      ];

      await Promise.all(operations);

      // Should not exceed max
      expect(concurrentStore.size).toBeLessThanOrEqual(100);
    });
  });
});
