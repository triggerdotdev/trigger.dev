import { defineConfig } from "vitest/config";

/**
 * CPU benchmarks. Kept out of the default suite because they run for minutes,
 * attach the V8 profiler, and report numbers rather than assert on them: on a
 * shared runner the timings swing far more than any threshold worth gating on.
 * Run on demand with `pnpm run test:bench`.
 */
export default defineConfig({
  test: {
    include: ["**/*.bench.test.ts"],
    globals: true,
    isolate: true,
    fileParallelism: false,
    testTimeout: 900_000,
  },
});
