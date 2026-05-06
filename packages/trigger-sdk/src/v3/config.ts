import type { TriggerConfig } from "@trigger.dev/core/v3";

export type {
  HandleErrorArgs,
  HandleErrorFunction,
  ResolveEnvironmentVariablesFunction,
  ResolveEnvironmentVariablesParams,
  ResolveEnvironmentVariablesResult,
} from "@trigger.dev/core/v3";

export function defineConfig(config: TriggerConfig): TriggerConfig {
  // `maxComputeSeconds` is the new name for `maxDuration`. If both are set, the new
  // name wins. Internally the SDK and platform still read `maxDuration`, so we
  // collapse the two fields here at the user-facing boundary.
  const { maxComputeSeconds, maxDuration, ...rest } = config;
  const resolved = maxComputeSeconds ?? maxDuration;
  return {
    ...rest,
    ...(resolved !== undefined ? { maxDuration: resolved } : {}),
  };
}

export type { TriggerConfig };
