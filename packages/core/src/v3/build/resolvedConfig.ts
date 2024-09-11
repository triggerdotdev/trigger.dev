import { type Defu } from "defu";
import type { Prettify } from "ts-essentials";
import { TriggerConfig } from "../config.js";
import { BuildRuntime } from "../schemas/build.js";
import { ResolveEnvironmentVariablesFunction } from "../types/index.js";

export type ResolvedConfig = Prettify<
  Defu<
    TriggerConfig,
    [
      {},
      {
        runtime: BuildRuntime;
        dirs: string[];
        tsconfig: string;
        build: {
          jsx: { factory: string; fragment: string; automatic: true };
        } & Omit<NonNullable<TriggerConfig["build"]>, "jsx">;
      },
    ]
  > & {
    workingDir: string;
    workspaceDir: string;
    packageJsonPath: string;
    lockfilePath: string;
    configFile?: string;
    resolveEnvVars?: ResolveEnvironmentVariablesFunction;
    instrumentedPackageNames?: string[];
  }
>;
