import { defineConfig } from "vitest/config";
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationShardingSequencer },
    include: ["test/**/*.e2e.test.ts"],
    globals: true,
    pool: "forks",
    /**
     * Each e2e file boots its own Docker stack (Postgres, Redis, s2-lite,
     * MinIO) plus a webapp process. Running files in parallel boots several
     * stacks at once and thrashes the CI runner into a timeout, so run them
     * one at a time, matching the repo's `pnpm test --no-file-parallelism`.
     */
    fileParallelism: false,
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
