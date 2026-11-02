import { defineConfig } from "vitest/config";
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    sequence: { sequencer: DurationShardingSequencer },
    // Webapp tests live under test/**; selected test families colocate next to source.
    // The run-store seam test colocates next to its source at app/v3/runStore.server.test.ts.
    // Pure unit tests for runEngine concerns colocate next to their source file.
    include: [
      "test/**/*.test.ts",
      "app/v3/environmentVariables/**/*.test.ts",
      "app/v3/runOpsMigration/**/*.test.ts",
      "app/v3/runStore.server.test.ts",
      "app/v3/validateMinimumCronInterval.test.ts",
      "app/v3/canUseAlertsList.test.ts",
      "app/v3/utils/**/*.test.ts",
      "app/v3/services/**/*.test.ts",
      "app/runEngine/concerns/**/*.test.ts",
      "app/runEngine/services/**/*.test.ts",
      "app/services/realtime/**/*.test.ts",
      "app/services/oidc/**/*.test.ts",
      "app/services/sessionAuthorizationTelemetry.server.test.ts",
      "app/services/previewAutoArchive.server.test.ts",
      "app/services/provisionBillingCustomer.server.test.ts",
      "app/services/magicLinkOrigin.server.test.ts",
      "app/services/turnstile.server.test.ts",
      "app/services/enqueueGithubBuild.server.test.ts",
      "app/services/clickhouse/**/*.test.ts",
      "app/utils/**/*.test.ts",
      "app/hooks/**/*.test.ts",
      "app/components/code/**/*.test.ts",
      "app/components/deployments/**/*.test.ts",
      "app/components/runs/**/*.test.ts",
      "app/components/dashboard-agent/**/*.test.ts",
      "app/components/queues/**/*.test.ts",
      "app/components/sessions/**/*.test.ts",
      "app/components/alerts/**/*.test.ts",
      "app/components/query/**/*.test.ts",
      "app/components/primitives/**/*.test.ts",
      "app/routes/storybook.agent-ui/*.test.ts",
      "app/routes/storybook.agent-wizard/*.test.ts",
      "app/routes/storybook.alerts/*.render.test.ts",
      "app/routes/storybook.alerts_.gallery/*.render.test.ts",
      "app/routes/storybook.alerts_.variant-1/*.render.test.tsx",
      "app/routes/_app.orgs.*alerts*/*.render.test.tsx",
      "app/routes/_app.orgs.*runs.$runParam/*.render.test.tsx",
      "app/routes/_app.orgs.*dashboards*/*.render.test.tsx",
      "app/presenters/v3/reports/**/*.test.ts",
      "app/presenters/v3/AlertDetailPresenter.server.test.ts",
      "app/presenters/v3/alertListRow.test.ts",
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
    maxWorkers: "50%",
    setupFiles: ["./test/setup.ts"], // test fallbacks and isolation
    server: { deps: { inline: [/@uiw\//] } },
  },
  resolve: {
    // Their CommonJS builds would load a second @codemirror/state beside the ESM one tests import.
    alias: [
      { find: /^@uiw\/react-codemirror$/, replacement: "@uiw/react-codemirror/esm/index.js" },
      {
        find: /^@uiw\/codemirror-extensions-basic-setup$/,
        replacement: "@uiw/codemirror-extensions-basic-setup/esm/index.js",
      },
    ],
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
