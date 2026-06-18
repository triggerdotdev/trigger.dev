import { defineConfig } from "vitest/config";
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationShardingSequencer },
    include: ["**/*.test.ts"],
    globals: true,
    isolate: true,
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
