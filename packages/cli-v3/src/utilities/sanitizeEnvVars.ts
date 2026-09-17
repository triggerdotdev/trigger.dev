/**
 * Sanitizes environment variables by removing entries with empty or undefined values.
 *
 * @param obj - An object containing environment variables as key-value pairs
 * @returns A new object containing only non-empty string values
 *
 * @example
 * const envVars = {
 *   API_KEY: "123",
 *   EMPTY_VAR: "",
 *   UNDEFINED_VAR: undefined,
 *   WHITESPACE: "   "
 * };
 * sanitizeEnvVars(envVars); // Returns { API_KEY: "123" }
 */
export const sanitizeEnvVars = (
  obj: Record<string, string | undefined>
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) =>
      typeof value === "string" ? !!value.trim() : !!value
    )
  ) as Record<string, string>;
};

/**
 * Keep machine defaults, fresh project values, and local overrides separate.
 * The worker's merged startup environment must not override fresh project values.
 */
export const buildDevRunEnv = ({
  resolvedEnvVars,
  processEnv,
  envOverrides,
  projectRef,
}: {
  resolvedEnvVars: Record<string, string> | undefined;
  processEnv: Record<string, string>;
  envOverrides: Record<string, string>;
  projectRef: string;
}): Record<string, string> => {
  return {
    ...processEnv,
    ...(resolvedEnvVars ?? {}),
    ...envOverrides,
    TRIGGER_PROJECT_REF: projectRef,
  };
};
