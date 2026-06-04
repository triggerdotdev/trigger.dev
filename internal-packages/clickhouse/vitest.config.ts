import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    globals: true,
    isolate: true,
    fileParallelism: false,
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
    },
  },
});
