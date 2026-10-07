import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    include: ["test/**/*.perf.test.ts"],
    globals: true,
    pool: "forks",
    /**
     * Heavy suites kept out of CI and run on demand with `pnpm run test:perf`:
     * wall-clock comparisons (single samples on a shared runner swing by more
     * than the ratios asserted) and large-trace stress runs. Their key
     * correctness cases also have a light version in the ordinary suites.
     */
    fileParallelism: false,
    testTimeout: 120_000,
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
