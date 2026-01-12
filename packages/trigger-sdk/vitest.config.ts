import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/v3/**/*.test.ts"],
    globals: true,
  },
});

