import type { OutputColumnMetadata } from "@internal/tsql";
import { useMemo } from "react";
import type {
  BigNumberAggregationType,
  BigNumberConfiguration,
} from "~/components/metrics/QueryWidget";
import { Spinner } from "../Spinner";
import { Paragraph } from "../Paragraph";

interface BigNumberCardProps {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  config: BigNumberConfiguration;
  isLoading?: boolean;
}

/**
 * Extracts numeric values from a specific column across all rows,
 * optionally sorting them first.
 */
function extractColumnValues(
  rows: Record<string, unknown>[],
  column: string,
  sortDirection?: "asc" | "desc"
): number[] {
  const values: number[] = [];
  const sortedRows = sortDirection
    ? [...rows].sort((a, b) => {
        const aVal = toNumber(a[column]);
        const bVal = toNumber(b[column]);
        return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
      })
    : rows;

  for (const row of sortedRows) {
    const val = row[column];
    if (typeof val === "number") {
      values.push(val);
    } else if (typeof val === "string") {
      const parsed = parseFloat(val);
      if (!isNaN(parsed)) {
        values.push(parsed);
      }
    }
  }
  return values;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Aggregate an array of numbers using the specified aggregation function
 */
function aggregateValues(values: number[], aggregation: BigNumberAggregationType): number {
  if (values.length === 0) return 0;
  switch (aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "count":
      return values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "first":
      return values[0];
    case "last":
      return values[values.length - 1];
  }
}

/**
 * Formats a number for display as a big number with abbreviation (K/M/B suffixes).
 */
function formatBigNumberAbbreviated(value: number): { formatted: string; unitSuffix?: string } {
  if (Math.abs(value) >= 1_000_000_000) {
    const v = value / 1_000_000_000;
    return { formatted: v % 1 === 0 ? v.toFixed(0) : v.toFixed(1), unitSuffix: "B" };
  }
  if (Math.abs(value) >= 1_000_000) {
    const v = value / 1_000_000;
    return { formatted: v % 1 === 0 ? v.toFixed(0) : v.toFixed(1), unitSuffix: "M" };
  }
  if (Math.abs(value) >= 1_000) {
    const v = value / 1_000;
    return { formatted: v % 1 === 0 ? v.toFixed(0) : v.toFixed(1), unitSuffix: "K" };
  }
  return { formatted: formatPlainNumber(value) };
}

/**
 * Formats a number for display without abbreviation.
 */
function formatPlainNumber(value: number): string {
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  if (Math.abs(value) < 0.01) {
    return value.toFixed(4);
  }
  if (Math.abs(value) < 1) {
    return value.toFixed(3);
  }
  return value.toFixed(2);
}

export function BigNumberCard({ rows, columns, config, isLoading = false }: BigNumberCardProps) {
  const { column, aggregation, sortDirection, abbreviate = false, prefix, suffix } = config;

  const result = useMemo(() => {
    if (rows.length === 0) return null;

    const values = extractColumnValues(rows, column, sortDirection);
    if (values.length === 0) return null;

    return aggregateValues(values, aggregation);
  }, [rows, column, aggregation, sortDirection]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (result === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Paragraph variant="small" className="text-text-dimmed">
          No data to display
        </Paragraph>
      </div>
    );
  }

  const { formatted, unitSuffix } = abbreviate
    ? formatBigNumberAbbreviated(result)
    : { formatted: formatPlainNumber(result), unitSuffix: undefined };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-[3.75rem] font-normal tabular-nums leading-none text-text-bright">
        <div className="flex items-baseline gap-1">
          {prefix && <span>{prefix}</span>}
          {formatted}
          {(unitSuffix || suffix) && (
            <div className="text-2xl text-text-dimmed">
              {unitSuffix}
              {unitSuffix && suffix ? " " : ""}
              {suffix}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
