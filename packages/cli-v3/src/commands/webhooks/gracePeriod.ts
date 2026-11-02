const MAX_GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60;

export const GRACE_PERIOD_CHOICES = [
  { value: 0, label: "Stop immediately", hint: "if the old secret leaked" },
  { value: 60 * 60, label: "1 hour" },
  { value: 24 * 60 * 60, label: "24 hours" },
  { value: MAX_GRACE_PERIOD_SECONDS, label: "7 days" },
] as const;

export const DEFAULT_GRACE_PERIOD_SECONDS = 24 * 60 * 60;

const UNIT_SECONDS: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

/**
 * Parses `--previous-secret-ttl`: whole seconds (`3600`) or a duration made of distinct units
 * (`1h`, `24h`, `7d`, `1d12h`).
 */
export function parseGracePeriod(value: string): number {
  const input = value.trim();
  const seconds = /^\d+$/.test(input) ? Number(input) : parseDuration(input);

  if (
    seconds === undefined ||
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_GRACE_PERIOD_SECONDS
  ) {
    throw new Error(
      `--previous-secret-ttl must be 0 or a duration up to 7d, such as 3600, 1h, 24h or 7d. Got "${value}".`
    );
  }

  return seconds;
}

function parseDuration(input: string): number | undefined {
  if (!/^(\d+(?:hr|[wdhms]))+$/.test(input)) return undefined;

  const seen = new Set<string>();
  let total = 0;
  for (const [, amount, suffix] of input.matchAll(/(\d+)(hr|[wdhms])/g)) {
    const unit = suffix === "hr" ? "h" : suffix!;
    if (seen.has(unit)) return undefined;
    seen.add(unit);
    total += Number(amount) * UNIT_SECONDS[unit]!;
  }
  return total;
}
