import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["e2e/vitest.d.ts"],
    globals: true,
    exclude: [...configDefaults.exclude, "src/**/*"],
  },
});
