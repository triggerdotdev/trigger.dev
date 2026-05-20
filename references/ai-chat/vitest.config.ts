import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: true,
    // The ai-chat reference app has Next.js + React code that we don't
    // want vitest trying to transform for these pure-logic tests. Keep
    // the env on `node` (default) and let users opt into jsdom per-file.
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
