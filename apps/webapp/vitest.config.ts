import { defineConfig } from "vitest/config";
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationShardingSequencer },
    // Webapp tests live under test/**; the run-ops migration family
    // colocates its *.server.test.ts next to source under app/v3/runOpsMigration/.
    // The run-store seam test colocates next to its source at app/v3/runStore.server.test.ts.
    // Pure unit tests for runEngine concerns colocate next to their source file.
    include: [
      "test/**/*.test.ts",
      "app/v3/runOpsMigration/**/*.test.ts",
      "app/v3/waitpointMigration/**/*.test.ts",
      "app/v3/runStore.server.test.ts",
      "app/v3/utils/**/*.test.ts",
      "app/v3/services/bulk/**/*.test.ts",
      "app/runEngine/concerns/**/*.test.ts",
      "app/runEngine/services/**/*.test.ts",
      "app/services/realtime/**/*.test.ts",
      "app/utils/**/*.test.ts",
      "app/components/code/**/*.test.ts",
      "app/components/runs/**/*.test.ts",
      "app/components/dashboard-agent/**/*.test.ts",
      "app/components/queues/**/*.test.ts",
      "app/routes/storybook.agent-ui/*.test.ts",
      "app/presenters/v3/reports/**/*.test.ts",
    ],
    // *.e2e.test.ts: smoke matrix, run via vitest.e2e.config.ts.
    // *.e2e.full.test.ts: full auth suite, runs via vitest.e2e.full.config.ts
    // (needs a globalSetup-spawned webapp + Postgres container).
    exclude: [
      "test/**/*.e2e.test.ts",
      "test/**/*.e2e.full.test.ts",
      "test/**/*.perf.test.ts",
      "test/bench/**",
    ],
    globals: true,
    pool: "forks",
    setupFiles: ["./test/setup.ts"], // load apps/webapp/.env
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
