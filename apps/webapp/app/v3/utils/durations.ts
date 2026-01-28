/**
 * Parse a duration string (e.g., "1s", "100ms", "5m", "1h", "1d") to milliseconds.
 * @throws Error if the duration string is invalid
 */
export function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);

  if (!match) {
    throw new Error(
      `Invalid duration string: "${duration}". Expected format: number + unit (ms, s, m, h, d)`
    );
  }

  const [, value, unit] = match;
  const numValue = parseFloat(value);

  switch (unit) {
    case "ms":
      return Math.round(numValue);
    case "s":
      return Math.round(numValue * 1000);
    case "m":
      return Math.round(numValue * 60 * 1000);
    case "h":
      return Math.round(numValue * 60 * 60 * 1000);
    case "d":
      return Math.round(numValue * 24 * 60 * 60 * 1000);
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

