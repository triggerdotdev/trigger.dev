import type { OutputColumnMetadata } from "@internal/tsql";
import { Hash } from "lucide-react";
import { useMemo } from "react";
import type {
  BigNumberAggregationType,
  BigNumberConfiguration,
} from "~/components/metrics/QueryWidget";
import { AnimatedNumber } from "../AnimatedNumber";
import { ChartBlankState } from "./ChartBlankState";
import { Spinner } from "../Spinner";

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
 * Computes the display value and unit suffix for abbreviated display.
 * Returns the divided-down number (e.g. 1.5 for 1500) and the suffix (e.g. "K"),
 * along with the appropriate decimal places for formatting.
 */
function abbreviateValue(value: number): {
  displayValue: number;
  unitSuffix?: string;
  decimalPlaces: number;
} {
  if (Math.abs(value) >= 1_000_000_000) {
    const v = value / 1_000_000_000;
    return { displayValue: v, unitSuffix: "B", decimalPlaces: v % 1 === 0 ? 0 : 1 };
  }
  if (Math.abs(value) >= 1_000_000) {
    const v = value / 1_000_000;
    return { displayValue: v, unitSuffix: "M", decimalPlaces: v % 1 === 0 ? 0 : 1 };
  }
  if (Math.abs(value) >= 1_000) {
    const v = value / 1_000;
    return { displayValue: v, unitSuffix: "K", decimalPlaces: v % 1 === 0 ? 0 : 1 };
  }
  return { displayValue: value, decimalPlaces: getDecimalPlaces(value) };
}

/**
 * Determines decimal places for plain (non-abbreviated) display.
 */
function getDecimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;
  const abs = Math.abs(value);
  if (abs >= 100) return 0;
  if (abs >= 10) return 1;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 3;
  return 4;
}

export function BigNumberCard({ rows, columns, config, isLoading = false }: BigNumberCardProps) {
  const { column, aggregation, sortDirection, abbreviate = true, prefix, suffix } = config;

  const result = useMemo(() => {
    if (rows.length === 0) return null;

    const values = extractColumnValues(rows, column, sortDirection);
    if (values.length === 0) return null;

    return aggregateValues(values, aggregation);
  }, [rows, column, aggregation, sortDirection]);

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center [container-type:size]">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (result === null) {
    return <ChartBlankState icon={Hash} message="No data to display" />;
  }

  const { displayValue, unitSuffix, decimalPlaces } = abbreviate
    ? abbreviateValue(result)
    : { displayValue: result, unitSuffix: undefined, decimalPlaces: getDecimalPlaces(result) };

  return (
    <div className="h-full w-full [container-type:size]">
      <div className="grid h-full w-full place-items-center">
        <div className="flex items-baseline gap-[0.15em] whitespace-nowrap font-normal tabular-nums leading-none text-text-bright text-[clamp(24px,12cqw,96px)]">
          {prefix && <span>{prefix}</span>}
          <AnimatedNumber value={displayValue} decimalPlaces={decimalPlaces} />
          {(unitSuffix || suffix) && (
            <span className="text-[0.4em] text-text-dimmed">
              {unitSuffix}
              {unitSuffix && suffix ? " " : ""}
              {suffix}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
