import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    globals: true,
    isolate: true,
    testTimeout: 10_000,
  },
});
