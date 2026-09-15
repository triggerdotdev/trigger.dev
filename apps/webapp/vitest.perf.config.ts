import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    include: ["test/**/*.perf.test.ts"],
    globals: true,
    pool: "forks",
    /**
     * These compare wall-clock timings between two implementations. Single
     * samples on a shared CI runner swing by more than the ratios being
     * asserted, so they are kept out of the default suite and run on demand
     * with `pnpm run test:perf`. Correctness is covered by the ordinary
     * suites; these exist to show the shape of the win and to catch a
     * large regression locally.
     */
    fileParallelism: false,
    testTimeout: 120_000,
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
