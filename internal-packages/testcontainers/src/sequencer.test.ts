import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import { DurationShardingSequencer } from "./sequencer.cjs";

const root = resolve(__dirname, "../../..");
const timings: Record<string, number> = JSON.parse(
  readFileSync(resolve(root, "test-timings.json"), "utf8")
);
const paths = Object.keys(timings).filter((file) => file.startsWith("internal-packages/"));
// Sequencing only consumes moduleId; these are inputs to the scheduling algorithm.
const specs = [...paths, "internal-packages/new-package/src/new.test.ts"].map(
  (file) => ({ moduleId: resolve(root, file) }) as TestSpecification
);

function sequencer(index: number, count: number) {
  return new DurationShardingSequencer({ config: { shard: { index, count } } } as Vitest);
}

describe("multi-project duration sharding", () => {
  test.each([1, 2, 3, 12, 24])(
    "assigns every file exactly once across %i shards",
    async (count) => {
      const shards = await Promise.all(
        Array.from({ length: count }, (_, index) => sequencer(index + 1, count).shard(specs))
      );
      const assigned = shards.flat().map((spec) => spec.moduleId);
      expect(assigned).toHaveLength(specs.length);
      expect(new Set(assigned).size).toBe(specs.length);
      expect(assigned.sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
    }
  );

  test("keeps the same assignment when project discovery order changes", async () => {
    for (let index = 1; index <= 12; index++) {
      const original = await sequencer(index, 12).shard(specs);
      const reversed = await sequencer(index, 12).shard([...specs].reverse());
      expect(reversed.map((spec) => spec.moduleId)).toEqual(original.map((spec) => spec.moduleId));
    }
  });

  test("retains all files without sharding and accepts an empty project", async () => {
    const unsharded = new DurationShardingSequencer({ config: {} } as Vitest);
    expect(await unsharded.shard(specs)).toBe(specs);
    expect(await sequencer(1, 12).shard([])).toEqual([]);
  });
});
