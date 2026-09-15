import { expect } from "vitest";
import { makeNShardRunOpsPostgresTest } from "./index.js";

const nShardTest = makeNShardRunOpsPostgresTest(2);

// Booting the PG14 + PG17 containers and cloning four databases on a cold runner far exceeds
// vitest's 5s default (this package sets no global testTimeout), so pass a generous per-test one.
nShardTest(
  "builds 4 distinct databases (legacy + new + 2 gen-2 shards)",
  async ({ legacyUri, newUri, shardUris }) => {
    expect(shardUris).toHaveLength(2);
    const all = [legacyUri, newUri, ...shardUris];
    expect(new Set(all).size).toBe(4);
  },
  120_000
);

nShardTest(
  "each gen-2 clone carries the run-ops subset schema",
  async ({ shardPrismas }) => {
    expect(shardPrismas).toHaveLength(2);
    for (const prisma of shardPrismas) {
      await expect(prisma.taskRun.count()).resolves.toBe(0);
    }
  },
  120_000
);
