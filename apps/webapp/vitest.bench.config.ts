import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * CPU benchmarks. Kept out of the default suite because they spawn a webapp,
 * run for minutes, attach the V8 profiler, and report numbers rather than
 * assert on them: on a shared runner the timings swing far more than any
 * threshold worth gating on. Needs a built webapp (`pnpm run build --filter
 * webapp`). Run on demand with `pnpm run test:bench`.
 */
export default defineConfig({
  test: {
    include: ["test/bench/**/*.bench.test.ts"],
    globals: true,
    pool: "forks",
    fileParallelism: false,
    testTimeout: 900_000,
    setupFiles: ["./test/setup.ts"],
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
