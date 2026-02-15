import type { ColumnFormatType } from "@internal/clickhouse";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";

/**
 * Format a number as binary bytes (KiB, MiB, GiB, TiB)
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(
    Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024))),
    units.length - 1
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * Format a number as decimal bytes (KB, MB, GB, TB)
 */
export function formatDecimalBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1000))),
    units.length - 1
  );
  return `${(bytes / Math.pow(1000, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * Format a large number with human-readable suffix (K, M, B)
 */
export function formatQuantity(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString();
}

/**
 * Creates a value formatter function for a given column format type.
 * Used by chart tooltips, legend values, and big number cards.
 */
export function createValueFormatter(
  format?: ColumnFormatType
): ((value: number) => string) | undefined {
  if (!format) return undefined;
  switch (format) {
    case "bytes":
      return (v) => formatBytes(v);
    case "decimalBytes":
      return (v) => formatDecimalBytes(v);
    case "percent":
      return (v) => `${v.toFixed(2)}%`;
    case "quantity":
      return (v) => formatQuantity(v);
    case "duration":
      return (v) => formatDurationMilliseconds(v, { style: "short" });
    case "durationSeconds":
      return (v) => formatDurationMilliseconds(v * 1000, { style: "short" });
    case "costInDollars":
      return (v) => formatCurrencyAccurate(v);
    case "cost":
      return (v) => formatCurrencyAccurate(v / 100);
    default:
      return undefined;
  }
}
