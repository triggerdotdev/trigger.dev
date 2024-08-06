import type { TriggerConfig } from "@trigger.dev/core/v3";

export type {
  HandleErrorArgs,
  HandleErrorFunction,
  ResolveEnvironmentVariablesFunction,
  ResolveEnvironmentVariablesParams,
  ResolveEnvironmentVariablesResult,
} from "@trigger.dev/core/v3";

export function defineConfig(config: TriggerConfig): TriggerConfig {
  return config;
}

export type { TriggerConfig };
