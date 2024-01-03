/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/tests/node/**/*.+(ts|tsx|js)"],
    exclude: ["**/tests/node/vitest.config.ts"],
  },
});
