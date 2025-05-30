import { env } from "std-env";

/**
 * Get an environment variable with optional default value. Runtime agnostic.
 *
 * @param name The name of the environment variable.
 * @param defaultValue The default value to return if the environment variable is not set.
 * @returns The value of the environment variable, or the default value if the environment variable is not set.
 *
 */
export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return env[name] ?? defaultValue;
}

export function getNumberEnvVar(name: string, defaultValue?: number): number | undefined {
  const value = getEnvVar(name);

  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (isNaN(parsed)) {
    return defaultValue;
  }

  return parsed;
}
