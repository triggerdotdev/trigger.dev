import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    globals: true,
    isolate: true,
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
    },
  },
});
