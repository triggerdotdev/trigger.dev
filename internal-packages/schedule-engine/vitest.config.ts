import { defineConfig } from "vitest/config";
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationShardingSequencer },
    globals: true,
    // CI-only: absorbs timing races (real-clock waits vs worker poll interval) under shard CPU contention
    retry: process.env.CI ? 2 : 0,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  esbuild: {
    target: "node18",
  },
});
