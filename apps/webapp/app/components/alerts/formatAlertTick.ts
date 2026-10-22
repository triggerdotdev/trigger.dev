import { formatNumberCompact } from "~/utils/numberFormatter";

const isMs = (unit: string) => unit === "ms" || unit === "duration_ms";
const isSeconds = (unit: string) => unit === "seconds" || unit === "s";
const isPercent = (unit: string) => unit === "%" || unit === "percent";

function withSuffix(text: string, unit: string): string {
  if (unit === "rate_per_hour") return `${text}/hr`;
  const suffix = unit === "count" ? "" : unit;
  return /^[a-z]/i.test(suffix) ? `${text} ${suffix}` : `${text}${suffix}`;
}

function axisDuration(n: number, scale: number): string {
  if (scale < 1000) return `${Math.round(n)}ms`;
  if (scale < 60_000 || n < 60_000) return `${+(n / 1000).toFixed(2)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

export function formatAlertTick(
  value: number,
  unit = "",
  scaleMax?: number,
  decimals?: number
): string {
  const n = Number(value);
  if (isSeconds(unit)) {
    return formatAlertTick(n * 1000, "ms", scaleMax === undefined ? undefined : scaleMax * 1000);
  }
  if (isMs(unit)) {
    if (scaleMax !== undefined) return axisDuration(n, Math.abs(scaleMax));
    if (Math.abs(n) >= 60_000) return `${+(n / 60_000).toFixed(1)}m`;
    if (Math.abs(n) >= 1000) return `${+(n / 1000).toFixed(1)}s`;
    return `${Math.round(n)}ms`;
  }
  if (isPercent(unit)) return `${+n.toFixed(decimals ?? 1)}%`;
  return withSuffix(formatNumberCompact(n), unit);
}

export function formatAlertValue(value: number, unit = ""): string {
  const n = Number(value);
  if (isSeconds(unit)) return formatAlertValue(n * 1000, "ms");
  if (isMs(unit)) {
    if (Math.abs(n) < 1000) return `${+n.toFixed(3)}ms`;
    if (Math.abs(n) >= 60_000 && n % 1000 === 0) {
      const minutes = Math.floor(n / 60_000);
      const seconds = (n % 60_000) / 1000;
      return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
    }
    return `${+(n / 1000).toFixed(3)}s`;
  }
  if (isPercent(unit)) return `${+n.toFixed(4)}%`;
  return withSuffix(n.toLocaleString("en"), unit);
}
