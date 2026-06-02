import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    globals: true,
    isolate: true,
    fileParallelism: false,
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
    },
  },
});
