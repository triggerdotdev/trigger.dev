import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationShardingSequencer },
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: { DASHBOARD_AGENT_API_ORIGIN: "http://localhost:3030" },
    isolate: true,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  esbuild: {
    target: "node18",
  },
});
