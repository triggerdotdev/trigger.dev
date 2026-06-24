import { defineConfig } from "vitest/config";

// Evals are separate from unit tests: they hit the real model (cost +
// nondeterminism), so they only run via `pnpm run test:evals`, never `pnpm test`.
export default defineConfig({
  test: {
    include: ["src/**/*.eval.ts"],
    environment: "node",
    setupFiles: ["./eval-setup.ts"],
    // Real-model turns run sequentially (the harness is single-agent-per-process).
    testTimeout: 240000,
    hookTimeout: 60000,
  },
  esbuild: {
    target: "node18",
  },
});
