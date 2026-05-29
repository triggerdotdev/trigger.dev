/** Convert a period string like "7d", "24h", "30m" to milliseconds. Defaults to 7d. */
export function parsePeriodToMs(period: string): number {
  const match = period.match(/^(\d+)([mhdw])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  switch (unit) {
    case "m":
      return num * 60 * 1000;
    case "h":
      return num * 60 * 60 * 1000;
    case "d":
      return num * 24 * 60 * 60 * 1000;
    case "w":
      return num * 7 * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}
