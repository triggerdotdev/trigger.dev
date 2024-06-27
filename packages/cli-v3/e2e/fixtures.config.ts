export interface TestCase {
  resolveEnv?: { [key: string]: string };
  id: string;
  workspaceRelativeDir?: string;
  skipTypecheck?: boolean;
  wantConfigNotFoundError?: boolean;
  wantConfigInvalidError?: boolean;
  wantCompilationError?: boolean;
  wantWorkerError?: boolean;
  wantDependenciesError?: boolean;
  wantInstallationError?: boolean;
}

export const fixturesConfig: TestCase[] = [
  {
    id: "compile-monorepo-packages",
    skipTypecheck: true,
    workspaceRelativeDir: "packages/trigger",
  },
  {
    id: "config-infisical-sdk",
    skipTypecheck: true,
  },
  {
    id: "config-invalid",
    wantConfigInvalidError: true,
  },
  {
    id: "config-not-found",
    wantConfigNotFoundError: true,
  },
  {
    id: "dep-to-add-scope-parsing",
    skipTypecheck: true,
  },
  {
    id: "lock-nested-peer-deps",
    skipTypecheck: true,
    resolveEnv: {
      npm_config_legacy_peer_deps: "true",
    },
  },
  {
    id: "resolve-legacy-peer-deps",
    skipTypecheck: true,
    // Should fail with better error at resolve
    wantWorkerError: true,
  },
  {
    id: "resolve-trigger-deps",
    skipTypecheck: true,
  },
  {
    id: "server-only",
    skipTypecheck: true,
  },
  {
    id: "trigger-dir-missing",
    skipTypecheck: true,
  },
  {
    id: "trigger-dir-not-found",
    skipTypecheck: true,
    // Should fail way before
    wantCompilationError: true,
  },
];
