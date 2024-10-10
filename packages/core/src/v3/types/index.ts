export * from "./utils.js";
export * from "./tasks.js";
export * from "./idempotencyKeys.js";

type ResolveEnvironmentVariablesOptions = {
  variables: Record<string, string> | Array<{ name: string; value: string }>;
  override?: boolean;
};

export type ResolveEnvironmentVariablesResult =
  | ResolveEnvironmentVariablesOptions
  | Promise<void | undefined | ResolveEnvironmentVariablesOptions>
  | void
  | undefined;

export type ResolveEnvironmentVariablesParams = {
  projectRef: string;
  environment: string;
  env: Record<string, string>;
};

export type ResolveEnvironmentVariablesFunction = (
  params: ResolveEnvironmentVariablesParams
) => ResolveEnvironmentVariablesResult;
