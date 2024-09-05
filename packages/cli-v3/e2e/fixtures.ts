import { BuildManifest, WorkerManifest } from "@trigger.dev/core/v3/schemas";

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

export interface TestCaseRun {
  task: {
    id: string;
    filePath: string;
    exportName: string;
  };
  payload: string;
  payloadType?: string;
  result: {
    ok: boolean;
    durationMs?: number;
  };
}

export interface TestCase {
  resolveEnv?: { [key: string]: string };
  id: string;
  workspaceRelativeDir?: string;
  wantConfigNotFoundError?: boolean;
  wantConfigInvalidError?: boolean;
  wantBuildWorkerError?: boolean;
  wantIndexingError?: boolean;
  wantWorkerError?: boolean;
  wantDependenciesError?: boolean;
  wantInstallationError?: boolean;
  buildManifestMatcher?: DeepPartial<BuildManifest>;
  workerManifestMatcher?: DeepPartial<WorkerManifest>;
  runs?: TestCaseRun[];
  tsconfig?: string;
}

export const fixturesConfig: TestCase[] = [
  {
    id: "hello-world",
    buildManifestMatcher: {
      runtime: "node",
      externals: [
        {
          name: "import-in-the-middle",
          version: "1.11.0",
        },
      ],
      files: [{ entry: "src/trigger/helloWorld.ts" }],
    },
    workerManifestMatcher: {
      tasks: [
        {
          id: "helloWorld",
          filePath: "src/trigger/helloWorld.ts",
          exportName: "helloWorld",
        },
      ],
    },
    runs: [
      {
        task: { id: "helloWorld", filePath: "src/trigger/helloWorld.ts", exportName: "helloWorld" },
        payload: "{}",
        result: { ok: true, durationMs: 1000 },
      },
    ],
    tsconfig: "tsconfig.json",
  },
];
