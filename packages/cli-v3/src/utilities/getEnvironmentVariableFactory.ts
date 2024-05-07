import { logger } from "./logger.js";

type VariableNames = "TRIGGER_API_URL" | "TRIGGER_SECRET_KEY" | "TRIGGER_LOG_LEVEL";

type DeprecatedNames = "";

/**
 * Create a function used to access an environment variable.
 *
 * This is not memoized to allow us to change the value at runtime, such as in testing.
 * A warning is shown if the client is using a deprecated version - but only once.
 */
export function getEnvironmentVariableFactory({
  variableName,
  deprecatedName,
}: {
  variableName: VariableNames;
  deprecatedName?: DeprecatedNames;
}): () => string | undefined;

/**
 * Create a function used to access an environment variable, with a default value.
 *
 * This is not memoized to allow us to change the value at runtime, such as in testing.
 * A warning is shown if the client is using a deprecated version - but only once.
 */
export function getEnvironmentVariableFactory({
  variableName,
  deprecatedName,
  defaultValue,
}: {
  variableName: VariableNames;
  deprecatedName?: DeprecatedNames;
  defaultValue: () => string;
}): () => string;

/**
 * Create a function used to access an environment variable.
 *
 * This is not memoized to allow us to change the value at runtime, such as in testing.
 * A warning is shown if the client is using a deprecated version - but only once.
 */
export function getEnvironmentVariableFactory({
  variableName,
  deprecatedName,
  defaultValue,
}: {
  variableName: VariableNames;
  deprecatedName?: DeprecatedNames;
  defaultValue?: () => string;
}): () => string | undefined {
  let hasWarned = false;
  return () => {
    if (process.env[variableName]) {
      return process.env[variableName];
    } else if (deprecatedName && process.env[deprecatedName]) {
      if (!hasWarned) {
        // Only show the warning once.
        hasWarned = true;
        logger.warn(
          `Using "${deprecatedName}" environment variable. This is deprecated. Please use "${variableName}", instead.`
        );
      }
      return process.env[deprecatedName];
    } else {
      return defaultValue?.();
    }
  };
}
