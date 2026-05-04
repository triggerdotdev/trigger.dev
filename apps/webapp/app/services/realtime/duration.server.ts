/**
 * Duration string parsing for stream-basin retention / delete-on-empty
 * configuration. Used by `streamBasinProvisioner` (to convert to S2's
 * integer-seconds wire format) and by `env.server.ts` (to validate
 * duration-shaped env vars at boot rather than at first use).
 *
 * Accepts the short forms (`7d`, `30d`, `365d`, `1h`, `90m`, `45s`,
 * `2w`, `1y`) and the human forms (`7days`, `1week`, `1year`).
 */

const PATTERN =
  /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hour|hours?|d|day|days?|w|week|weeks?|y|year|years?)$/;

export function isValidDuration(input: string): boolean {
  return PATTERN.test(input.trim().toLowerCase());
}

/**
 * Parse a duration string into seconds. Throws on garbage so a
 * misconfigured env var fails loudly. Use {@link isValidDuration}
 * for non-throwing validation (e.g. inside a Zod `.refine()`).
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(PATTERN);
  if (!match) {
    throw new Error(`Invalid duration string: ${input}`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multiplier =
    /^s/.test(unit)
      ? 1
      : /^m(?:in|ins|inute|inutes)?$/.test(unit)
        ? 60
        : /^h/.test(unit)
          ? 3600
          : /^d/.test(unit)
            ? 86400
            : /^w/.test(unit)
              ? 604800
              : /^y/.test(unit)
                ? 31_536_000
                : NaN;
  if (!Number.isFinite(multiplier)) {
    throw new Error(`Invalid duration unit: ${unit}`);
  }
  return value * multiplier;
}
