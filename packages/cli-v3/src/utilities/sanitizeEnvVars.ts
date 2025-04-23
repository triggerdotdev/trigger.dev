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
