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
    exportName?: string;
  };
  payload: string;
  payloadType?: string;
  result: {
    ok: boolean;
    durationMs?: number;
    output?: string;
    outputType?: string;
    spans?: string[];
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
  envVars?: { [key: string]: string };
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
  {
    id: "otel-telemetry-loader",
    buildManifestMatcher: {
      runtime: "node",
      externals: [
        {
          name: "openai",
          version: "4.47.0",
        },
        {
          name: "import-in-the-middle",
          version: "1.11.0",
        },
      ],
      files: [{ entry: "src/trigger/ai.ts" }],
    },
    workerManifestMatcher: {
      tasks: [
        {
          id: "ai",
          filePath: "src/trigger/ai.ts",
        },
      ],
    },
    runs: [
      {
        task: { id: "ai", filePath: "src/trigger/ai.ts" },
        payload: '{"prompt":"be funny"}',
        result: { ok: true, durationMs: 1 },
      },
    ],
    tsconfig: "tsconfig.json",
    envVars: {
      OPENAI_API_KEY: "my-api-key",
    },
  },
  {
    id: "emit-decorator-metadata",
    buildManifestMatcher: {
      runtime: "node",
      externals: [
        {
          name: "import-in-the-middle",
          version: "1.11.0",
        },
      ],
      files: [{ entry: "src/trigger/decorators.ts" }],
    },
    workerManifestMatcher: {
      tasks: [
        {
          id: "decoratorsTask",
          filePath: "src/trigger/decorators.ts",
        },
      ],
    },
    runs: [
      {
        task: { id: "decoratorsTask", filePath: "src/trigger/decorators.ts" },
        payload: "{}",
        result: { ok: true, durationMs: 1 },
      },
    ],
    tsconfig: "tsconfig.json",
  },
  {
    id: "monorepo-react-email",
    workspaceRelativeDir: "packages/trigger",
    tsconfig: "tsconfig.json",
    buildManifestMatcher: {
      runtime: "node",
      externals: [
        {
          name: "import-in-the-middle",
          version: "1.11.0",
        },
      ],
      files: [{ entry: "src/reactEmail.tsx" }],
    },
    workerManifestMatcher: {
      tasks: [
        {
          id: "react-email",
          filePath: "src/reactEmail.tsx",
        },
      ],
    },
    runs: [
      {
        task: { id: "react-email", filePath: "src/reactEmail.tsx" },
        payload: "{}",
        result: {
          ok: true,
          output:
            '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><!--$--><html dir="ltr" lang="en"><a href="https://example.com" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;background:#000;color:#fff;padding:12px 20px 12px 20px" target="_blank"><span><!--[if mso]><i style="mso-font-width:500%;mso-text-raise:18" hidden>&#8202;&#8202;</i><![endif]--></span><span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Click me</span><span><!--[if mso]><i style="mso-font-width:500%" hidden>&#8202;&#8202;&#8203;</i><![endif]--></span></a></html><!--/$-->',
          outputType: "text/plain",
        },
      },
    ],
  },
  {
    id: "esm-only-external",
    buildManifestMatcher: {
      runtime: "node",
      externals: [
        {
          name: "import-in-the-middle",
          version: "1.11.0",
        },
        {
          name: "mupdf",
          version: "0.3.0",
        },
      ],
      files: [{ entry: "src/trigger/helloWorld.ts" }],
    },
    workerManifestMatcher: {
      tasks: [
        {
          id: "helloWorld",
          filePath: "src/trigger/helloWorld.ts",
        },
      ],
    },
    runs: [
      {
        task: { id: "helloWorld", filePath: "src/trigger/helloWorld.ts" },
        payload: "{}",
        result: { ok: true, durationMs: 1 },
      },
    ],
    tsconfig: "tsconfig.json",
  },
];
