import type { OutputColumnMetadata } from "@internal/clickhouse";
import { BarChart, LineChart } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { cn } from "~/utils/cn";
import { Header3 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { Select, SelectItem } from "../primitives/Select";
import { Switch } from "../primitives/Switch";

export type ChartType = "bar" | "line";

export interface ChartConfiguration {
  chartType: ChartType;
  xAxisColumn: string | null;
  yAxisColumns: string[];
  groupByColumn: string | null;
  stacked: boolean;
}

export const defaultChartConfig: ChartConfiguration = {
  chartType: "bar",
  xAxisColumn: null,
  yAxisColumns: [],
  groupByColumn: null,
  stacked: false,
};

interface ChartConfigPanelProps {
  columns: OutputColumnMetadata[];
  config: ChartConfiguration;
  onChange: (config: ChartConfiguration) => void;
  className?: string;
}

// Type detection helpers
function isNumericType(type: string): boolean {
  return (
    type.startsWith("Int") ||
    type.startsWith("UInt") ||
    type.startsWith("Float") ||
    type.startsWith("Decimal") ||
    type.startsWith("Nullable(Int") ||
    type.startsWith("Nullable(UInt") ||
    type.startsWith("Nullable(Float") ||
    type.startsWith("Nullable(Decimal")
  );
}

function isDateTimeType(type: string): boolean {
  return (
    type === "DateTime" ||
    type === "DateTime64" ||
    type === "Date" ||
    type === "Date32" ||
    type.startsWith("DateTime64(") ||
    type.startsWith("Nullable(DateTime") ||
    type.startsWith("Nullable(Date")
  );
}

function isStringType(type: string): boolean {
  return (
    type === "String" ||
    type === "LowCardinality(String)" ||
    type === "Nullable(String)" ||
    type.startsWith("Enum") ||
    type.startsWith("FixedString")
  );
}

export function ChartConfigPanel({ columns, config, onChange, className }: ChartConfigPanelProps) {
  // Categorize columns by type
  const { numericColumns, dateTimeColumns, categoricalColumns, allColumns } = useMemo(() => {
    const numeric: OutputColumnMetadata[] = [];
    const dateTime: OutputColumnMetadata[] = [];
    const categorical: OutputColumnMetadata[] = [];

    for (const col of columns) {
      if (isNumericType(col.type)) {
        numeric.push(col);
      }
      if (isDateTimeType(col.type)) {
        dateTime.push(col);
      }
      if (isStringType(col.type) || isDateTimeType(col.type)) {
        categorical.push(col);
      }
    }

    return {
      numericColumns: numeric,
      dateTimeColumns: dateTime,
      categoricalColumns: categorical,
      allColumns: columns,
    };
  }, [columns]);

  // Auto-select defaults when columns change
  useEffect(() => {
    if (columns.length === 0) return;

    let needsUpdate = false;
    const updates: Partial<ChartConfiguration> = {};

    // Auto-select X-axis (prefer datetime, then first categorical)
    if (!config.xAxisColumn) {
      const defaultX = dateTimeColumns[0] ?? categoricalColumns[0] ?? columns[0];
      if (defaultX) {
        updates.xAxisColumn = defaultX.name;
        needsUpdate = true;
      }
    }

    // Auto-select Y-axis (first numeric column)
    if (config.yAxisColumns.length === 0 && numericColumns.length > 0) {
      updates.yAxisColumns = [numericColumns[0].name];
      needsUpdate = true;
    }

    if (needsUpdate) {
      onChange({ ...config, ...updates });
    }
  }, [columns, config, onChange, dateTimeColumns, categoricalColumns, numericColumns]);

  const updateConfig = useCallback(
    (updates: Partial<ChartConfiguration>) => {
      onChange({ ...config, ...updates });
    },
    [config, onChange]
  );

  // X-axis options: prefer datetime and string columns at the top
  const xAxisOptions = useMemo(() => {
    const preferred = [
      ...dateTimeColumns,
      ...categoricalColumns.filter((c) => !isDateTimeType(c.type)),
    ];
    const preferredNames = new Set(preferred.map((c) => c.name));
    const other = allColumns.filter((c) => !preferredNames.has(c.name));

    const options: Array<{ value: string; label: string; type: string }> = [];

    for (const col of preferred) {
      options.push({ value: col.name, label: col.name, type: col.type });
    }
    for (const col of other) {
      options.push({ value: col.name, label: col.name, type: col.type });
    }

    return options;
  }, [allColumns, dateTimeColumns, categoricalColumns]);

  // Y-axis options: numeric columns only
  const yAxisOptions = useMemo(() => {
    return numericColumns.map((col) => ({
      value: col.name,
      label: col.name,
      type: col.type,
    }));
  }, [numericColumns]);

  // Group by options: categorical columns (excluding selected X axis)
  const groupByOptions = useMemo(() => {
    const options = categoricalColumns
      .filter((col) => col.name !== config.xAxisColumn)
      .map((col) => ({
        value: col.name,
        label: col.name,
        type: col.type,
      }));

    return [{ value: "__none__", label: "None", type: "" }, ...options];
  }, [categoricalColumns, config.xAxisColumn]);

  if (columns.length === 0) {
    return (
      <div className={cn("flex items-center justify-center p-4", className)}>
        <Paragraph variant="small" className="text-text-dimmed">
          Run a query to configure the chart
        </Paragraph>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-3 px-3 py-2", className)}>
      {/* Chart Type */}
      <ConfigField label="Type">
        <div className="flex gap-1">
          <ChartTypeButton
            type="bar"
            selected={config.chartType === "bar"}
            onClick={() => updateConfig({ chartType: "bar" })}
          />
          <ChartTypeButton
            type="line"
            selected={config.chartType === "line"}
            onClick={() => updateConfig({ chartType: "line" })}
          />
        </div>
      </ConfigField>

      {/* X-Axis */}
      <ConfigField label="X-Axis">
        <Select
          value={config.xAxisColumn ?? ""}
          setValue={(value) => updateConfig({ xAxisColumn: value || null })}
          variant="tertiary/small"
          placeholder="Select column"
          items={xAxisOptions}
          dropdownIcon
          className="min-w-[140px]"
        >
          {(items) =>
            items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="flex items-center gap-2">
                  <span>{item.label}</span>
                  <TypeBadge type={item.type} />
                </span>
              </SelectItem>
            ))
          }
        </Select>
      </ConfigField>

      {/* Y-Axis */}
      <ConfigField label="Y-Axis">
        {yAxisOptions.length === 0 ? (
          <span className="text-xs text-text-dimmed">No numeric columns</span>
        ) : (
          <Select
            value={config.yAxisColumns[0] ?? ""}
            setValue={(value) => updateConfig({ yAxisColumns: value ? [value] : [] })}
            variant="tertiary/small"
            placeholder="Select column"
            items={yAxisOptions}
            dropdownIcon
            className="min-w-[140px]"
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <span className="flex items-center gap-2">
                    <span>{item.label}</span>
                    <TypeBadge type={item.type} />
                  </span>
                </SelectItem>
              ))
            }
          </Select>
        )}
      </ConfigField>

      {/* Group By */}
      <ConfigField label="Group by">
        <Select
          value={config.groupByColumn ?? "__none__"}
          setValue={(value) => updateConfig({ groupByColumn: value === "__none__" ? null : value })}
          variant="tertiary/small"
          placeholder="None"
          items={groupByOptions}
          dropdownIcon
          className="min-w-[140px]"
        >
          {(items) =>
            items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="flex items-center gap-2">
                  <span>{item.label}</span>
                  {item.type && <TypeBadge type={item.type} />}
                </span>
              </SelectItem>
            ))
          }
        </Select>
      </ConfigField>

      {/* Stacked toggle (only when grouped) */}
      {config.groupByColumn && (
        <ConfigField label="">
          <Switch
            variant="small"
            label="Stacked"
            checked={config.stacked}
            onCheckedChange={(checked) => updateConfig({ stacked: checked })}
          />
        </ConfigField>
      )}
    </div>
  );
}

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-text-dimmed">{label}</span>}
      {children}
    </div>
  );
}

function ChartTypeButton({
  type,
  selected,
  onClick,
}: {
  type: ChartType;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = type === "bar" ? BarChart : LineChart;
  const label = type === "bar" ? "Bar" : "Line";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
        selected
          ? "bg-charcoal-700 text-text-bright"
          : "text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright"
      )}
      title={`${label} chart`}
    >
      <Icon className="size-3.5" />
      <span>{label}</span>
    </button>
  );
}

function TypeBadge({ type }: { type: string }) {
  // Simplify type for display
  let displayType = type;
  if (type.startsWith("Nullable(")) {
    displayType = type.slice(9, -1) + "?";
  }
  if (type.startsWith("LowCardinality(")) {
    displayType = type.slice(15, -1);
  }

  // Shorten long type names
  if (displayType.length > 12) {
    displayType = displayType.slice(0, 10) + "…";
  }

  return (
    <span className="rounded bg-charcoal-750 px-1 py-0.5 font-mono text-xxs text-text-dimmed">
      {displayType}
    </span>
  );
}
