import { resolveDotEnvVars } from "./dotEnv.js";
import { buildDevRunEnv, sanitizeEnvVars } from "./sanitizeEnvVars.js";

export function resolveDevEnvVars({
  envFile,
  projectEnv,
  overrides,
  projectRef,
}: {
  envFile?: string;
  projectEnv: Record<string, string>;
  overrides: Record<string, string>;
  projectRef: string;
}) {
  const processEnv = sanitizeEnvVars(gatherProcessEnv());
  const envOverrides = {
    ...sanitizeEnvVars(resolveDotEnvVars(undefined, envFile)),
    ...overrides,
  };
  return {
    processEnv,
    envOverrides,
    env: buildDevRunEnv({ resolvedEnvVars: projectEnv, processEnv, envOverrides, projectRef }),
  };
}

export function resolveLocalEnvVars(
  envFile?: string,
  additionalVariables?: Record<string, string>
) {
  const processEnv = gatherProcessEnv();
  const dotEnvVars = resolveDotEnvVars(undefined, envFile);

  return {
    ...sanitizeEnvVars(processEnv),
    ...sanitizeEnvVars(additionalVariables ?? {}),
    ...sanitizeEnvVars(dotEnvVars),
  };
}

function gatherProcessEnv() {
  const $env = {
    ...process.env,
  };

  // Filter out undefined values
  return Object.fromEntries(Object.entries($env).filter(([key, value]) => value !== undefined));
}
