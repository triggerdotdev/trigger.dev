import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    globals: true,
    isolate: true,
    testTimeout: 120_000, // Some framework builds can take time
    hookTimeout: 60_000,
  },
});
