import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
