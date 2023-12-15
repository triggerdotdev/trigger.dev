/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/tests/wrangler/**/(*.)+(test).+(ts|tsx)"],
    exclude: ["**/tests/wrangler/vitest.config.ts"],
  },
});
