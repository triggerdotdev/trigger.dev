import type { OutputColumnMetadata } from "@internal/tsql";
import { useMemo } from "react";
import type { AggregationType, BigNumberConfiguration } from "~/components/metrics/QueryWidget";
import { Spinner } from "../Spinner";
import { Paragraph } from "../Paragraph";

interface BigNumberCardProps {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  config: BigNumberConfiguration;
  isLoading?: boolean;
}

/**
 * Extracts numeric values from a specific column across all rows
 */
function extractColumnValues(rows: Record<string, unknown>[], column: string): number[] {
  const values: number[] = [];
  for (const row of rows) {
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

/**
 * Aggregate an array of numbers using the specified aggregation function
 */
function aggregateValues(values: number[], aggregation: AggregationType): number {
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
  }
}

/**
 * Formats a number for display as a big number.
 * Uses K/M suffixes for large values, appropriate decimal places for small values.
 */
function formatBigNumber(value: number): { formatted: string; suffix?: string } {
  if (Math.abs(value) >= 1_000_000_000) {
    const v = value / 1_000_000_000;
    return { formatted: v % 1 === 0 ? v.toFixed(0) : v.toFixed(1), suffix: "B" };
  }
  if (Math.abs(value) >= 1_000_000) {
    const v = value / 1_000_000;
    return { formatted: v % 1 === 0 ? v.toFixed(0) : v.toFixed(1), suffix: "M" };
  }
  if (Math.abs(value) >= 1_000) {
    const v = value / 1_000;
    return { formatted: v % 1 === 0 ? v.toFixed(0) : v.toFixed(1), suffix: "K" };
  }
  if (Number.isInteger(value)) {
    return { formatted: value.toLocaleString() };
  }
  if (Math.abs(value) < 0.01) {
    return { formatted: value.toFixed(4) };
  }
  if (Math.abs(value) < 1) {
    return { formatted: value.toFixed(3) };
  }
  return { formatted: value.toFixed(2) };
}

export function BigNumberCard({ rows, columns, config, isLoading = false }: BigNumberCardProps) {
  const { column, aggregation } = config;

  const result = useMemo(() => {
    if (rows.length === 0) return null;

    const values = extractColumnValues(rows, column);
    if (values.length === 0) return null;

    return aggregateValues(values, aggregation);
  }, [rows, column, aggregation]);

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

  const { formatted, suffix } = formatBigNumber(result);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-[3.75rem] font-normal tabular-nums leading-none text-text-bright">
        <div className="flex items-baseline gap-1">
          {formatted}
          {suffix && <div className="text-2xl text-text-dimmed">{suffix}</div>}
        </div>
      </div>
    </div>
  );
}
