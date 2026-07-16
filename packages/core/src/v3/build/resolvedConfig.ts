import { type Defu } from "defu";
import type { Prettify } from "ts-essentials";
import type { CompatibilityFlag, CompatibilityFlagFeatures, TriggerConfig } from "../config.js";
import type { BuildRuntime } from "../schemas/build.js";
import type { ResolveEnvironmentVariablesFunction } from "../types/index.js";

export type ResolvedConfig = Prettify<
  Omit<
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
          compatibilityFlags: CompatibilityFlag[];
          features: CompatibilityFlagFeatures;
        },
      ]
    >,
    "runtime"
  > & {
    runtime: BuildRuntime;
    workingDir: string;
    workspaceDir: string;
    packageJsonPath: string;
    lockfilePath: string;
    configFile?: string;
    tsconfigPath?: string;
    resolveEnvVars?: ResolveEnvironmentVariablesFunction;
    instrumentedPackageNames?: string[];
  }
>;
