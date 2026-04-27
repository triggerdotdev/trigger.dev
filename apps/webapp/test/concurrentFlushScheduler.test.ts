import { ConcurrentFlushScheduler } from "~/services/runsReplicationService.server";

vi.setConfig({ testTimeout: 10_000 });

type TestItem = {
  id: string;
  event: "insert" | "update";
  version: number;
};

describe("ConcurrentFlushScheduler", () => {
  it("should deduplicate items by key, keeping the latest version", async () => {
    const flushedBatches: TestItem[][] = [];

    const scheduler = new ConcurrentFlushScheduler<TestItem>({
      batchSize: 100,
      flushInterval: 50,
      maxConcurrency: 1,
      callback: async (_flushId, batch) => {
        flushedBatches.push([...batch]);
      },
      getKey: (item) => `${item.event}_${item.id}`,
      shouldReplace: (existing, incoming) => incoming.version >= existing.version,
    });

    scheduler.start();

    // Add items with duplicate keys but different versions
    scheduler.addToBatch([
      { id: "run_1", event: "insert", version: 1 },
      { id: "run_1", event: "update", version: 2 },
      { id: "run_2", event: "insert", version: 1 },
    ]);

    // Add more items - should merge with existing
    scheduler.addToBatch([
      { id: "run_1", event: "insert", version: 3 }, // Higher version, should replace
      { id: "run_1", event: "update", version: 1 }, // Lower version, should NOT replace
      { id: "run_2", event: "update", version: 4 },
    ]);

    // Wait for flush
    await new Promise((resolve) => setTimeout(resolve, 100));

    scheduler.shutdown();

    // Should have flushed once with deduplicated items
    expect(flushedBatches.length).toBeGreaterThanOrEqual(1);

    const allFlushed = flushedBatches.flat();

    // Find items by their key
    const insertRun1 = allFlushed.find((i) => i.id === "run_1" && i.event === "insert");
    const updateRun1 = allFlushed.find((i) => i.id === "run_1" && i.event === "update");
    const insertRun2 = allFlushed.find((i) => i.id === "run_2" && i.event === "insert");
    const updateRun2 = allFlushed.find((i) => i.id === "run_2" && i.event === "update");

    // Verify correct versions were kept
    expect(insertRun1?.version).toBe(3); // Latest version for insert_run_1
    expect(updateRun1?.version).toBe(2); // Original update_run_1 (v1 didn't replace v2)
    expect(insertRun2?.version).toBe(1); // Only version for insert_run_2
    expect(updateRun2?.version).toBe(4); // Only version for update_run_2
  });

  it("should skip items where getKey returns null", async () => {
    const flushedBatches: TestItem[][] = [];

    const scheduler = new ConcurrentFlushScheduler<TestItem>({
      batchSize: 100,
      flushInterval: 50,
      maxConcurrency: 1,
      callback: async (_flushId, batch) => {
        flushedBatches.push([...batch]);
      },
      getKey: (item) => {
        if (!item.id) {
          return null;
        }
        return `${item.event}_${item.id}`;
      },
      shouldReplace: (existing, incoming) => incoming.version >= existing.version,
    });

    scheduler.start();

    scheduler.addToBatch([
      { id: "run_1", event: "insert", version: 1 },
      { id: "", event: "insert", version: 2 }, // Should be skipped (null key)
      { id: "run_2", event: "insert", version: 1 },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));

    scheduler.shutdown();

    const allFlushed = flushedBatches.flat();
    expect(allFlushed).toHaveLength(2);
    expect(allFlushed.map((i) => i.id).sort()).toEqual(["run_1", "run_2"]);
  });

  it("should flush when batch size threshold is reached", async () => {
    const flushedBatches: TestItem[][] = [];

    const scheduler = new ConcurrentFlushScheduler<TestItem>({
      batchSize: 3,
      flushInterval: 10000, // Long interval so timer doesn't trigger
      maxConcurrency: 1,
      callback: async (_flushId, batch) => {
        flushedBatches.push([...batch]);
      },
      getKey: (item) => `${item.event}_${item.id}`,
      shouldReplace: (existing, incoming) => incoming.version >= existing.version,
    });

    scheduler.start();

    // Add 3 unique items - should trigger flush
    scheduler.addToBatch([
      { id: "run_1", event: "insert", version: 1 },
      { id: "run_2", event: "insert", version: 1 },
      { id: "run_3", event: "insert", version: 1 },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0]).toHaveLength(3);

    scheduler.shutdown();
  });

  it("should respect shouldReplace returning false", async () => {
    const flushedBatches: TestItem[][] = [];

    const scheduler = new ConcurrentFlushScheduler<TestItem>({
      batchSize: 100,
      flushInterval: 50,
      maxConcurrency: 1,
      callback: async (_flushId, batch) => {
        flushedBatches.push([...batch]);
      },
      getKey: (item) => `${item.event}_${item.id}`,
      // Never replace - first item wins
      shouldReplace: () => false,
    });

    scheduler.start();

    scheduler.addToBatch([{ id: "run_1", event: "insert", version: 10 }]);

    scheduler.addToBatch([{ id: "run_1", event: "insert", version: 999 }]);

    await new Promise((resolve) => setTimeout(resolve, 100));

    scheduler.shutdown();

    const allFlushed = flushedBatches.flat();
    const insertRun1 = allFlushed.find((i) => i.id === "run_1" && i.event === "insert");
    expect(insertRun1?.version).toBe(10); // First one wins
  });
});
