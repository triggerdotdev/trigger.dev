import { defineConfig } from "vitest/config";
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationShardingSequencer },
    include: ["test/**/*.e2e.test.ts", "app/routes/**/*.e2e.test.ts"],
    globals: true,
    pool: "forks",
    /**
     * Each e2e file boots a webapp process plus Redis, s2-lite and MinIO, and
     * clones its database from the shared test Postgres. A few files at a time
     * keeps the runner from thrashing.
     */
    maxWorkers: 4,
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
