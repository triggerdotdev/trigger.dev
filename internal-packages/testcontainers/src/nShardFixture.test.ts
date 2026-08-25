import { expect } from "vitest";
import { makeNShardRunOpsPostgresTest } from "./index.js";

const nShardTest = makeNShardRunOpsPostgresTest(2);

nShardTest(
  "builds 4 distinct databases (legacy + new + 2 gen-2 shards)",
  async ({ legacyUri, newUri, shardUris }) => {
    expect(shardUris).toHaveLength(2);
    const all = [legacyUri, newUri, ...shardUris];
    expect(new Set(all).size).toBe(4);
  }
);

nShardTest("each gen-2 clone carries the run-ops subset schema", async ({ shardPrismas }) => {
  expect(shardPrismas).toHaveLength(2);
  for (const prisma of shardPrismas) {
    await expect(prisma.taskRun.count()).resolves.toBe(0);
  }
});
