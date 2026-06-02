/**
 * Collapse the user-facing `maxComputeSeconds` (new name) and `maxDuration` (deprecated)
 * into a single value. If both are provided, `maxComputeSeconds` wins.
 *
 * Internal SDK/CLI/platform code only reads `maxDuration`, so all call sites that
 * accept user input should funnel through this helper before forwarding the value.
 */
export function resolveMaxComputeSeconds(input: {
  maxComputeSeconds?: number;
  maxDuration?: number;
}): number | undefined {
  return input.maxComputeSeconds ?? input.maxDuration;
}
