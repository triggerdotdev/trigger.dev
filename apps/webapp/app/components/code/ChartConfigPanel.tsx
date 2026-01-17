import type { OutputColumnMetadata } from "@internal/clickhouse";
import { BarChart, LineChart, Plus, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "~/utils/cn";
import { Header3 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { Select, SelectItem } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { Button } from "../primitives/Buttons";

export type ChartType = "bar" | "line";
export type SortDirection = "asc" | "desc";
export type AggregationType = "sum" | "avg" | "count" | "min" | "max";

export interface ChartConfiguration {
  chartType: ChartType;
  xAxisColumn: string | null;
  yAxisColumns: string[];
  groupByColumn: string | null;
  stacked: boolean;
  sortByColumn: string | null;
  sortDirection: SortDirection;
  aggregation: AggregationType;
}

export const defaultChartConfig: ChartConfiguration = {
  chartType: "bar",
  xAxisColumn: null,
  yAxisColumns: [],
  groupByColumn: null,
  stacked: false,
  sortByColumn: null,
  sortDirection: "asc",
  aggregation: "sum",
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

  // Create a stable key from column names and types to detect actual changes
  const columnsKey = useMemo(() => columns.map((c) => `${c.name}:${c.type}`).join(","), [columns]);

  // Use refs to access current config/onChange without adding them as dependencies
  const configRef = useRef(config);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    configRef.current = config;
    onChangeRef.current = onChange;
  });

  // Auto-select defaults when columns change
  useEffect(() => {
    if (columns.length === 0) return;

    const currentConfig = configRef.current;
    let needsUpdate = false;
    const updates: Partial<ChartConfiguration> = {};

    // Auto-select X-axis (prefer datetime, then first categorical)
    if (!currentConfig.xAxisColumn) {
      const defaultX = dateTimeColumns[0] ?? categoricalColumns[0] ?? columns[0];
      if (defaultX) {
        updates.xAxisColumn = defaultX.name;
        needsUpdate = true;
      }
    }

    // Auto-select Y-axis (first numeric column)
    if (currentConfig.yAxisColumns.length === 0 && numericColumns.length > 0) {
      updates.yAxisColumns = [numericColumns[0].name];
      needsUpdate = true;
    }

    // Determine the effective x-axis column (either existing or newly selected)
    const effectiveXAxis = updates.xAxisColumn ?? currentConfig.xAxisColumn;

    // Auto-set sort to x-axis ASC if it's a datetime column and no sort is configured
    if (
      effectiveXAxis &&
      !currentConfig.sortByColumn &&
      dateTimeColumns.some((col) => col.name === effectiveXAxis)
    ) {
      updates.sortByColumn = effectiveXAxis;
      updates.sortDirection = "asc";
      needsUpdate = true;
    }

    if (needsUpdate) {
      onChangeRef.current({ ...currentConfig, ...updates });
    }
    // Only re-run when the actual column structure changes, not on every config change
  }, [columnsKey, columns, dateTimeColumns, categoricalColumns, numericColumns]);

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

  // Aggregation options
  const aggregationOptions = [
    { value: "sum", label: "Sum" },
    { value: "avg", label: "Average" },
    { value: "count", label: "Count" },
    { value: "min", label: "Min" },
    { value: "max", label: "Max" },
  ];

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

  // Sort by options: all columns
  const sortByOptions = useMemo(() => {
    const options = allColumns.map((col) => ({
      value: col.name,
      label: col.name,
      type: col.type,
    }));

    return [{ value: "__none__", label: "None", type: "" }, ...options];
  }, [allColumns]);

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
    <div className={cn("flex flex-col gap-2 p-2", className)}>
      {/* Chart Type */}
      <div className="flex flex-col gap-3">
        <ConfigField label="Type">
          <div className="flex items-center">
            <Button
              type="button"
              variant="tertiary/small"
              className={cn(
                "rounded-r-none border-b pl-1 pr-2",
                config.chartType === "bar" ? "border-indigo-500" : "border-transparent"
              )}
              iconSpacing="gap-x-1"
              onClick={() => updateConfig({ chartType: "bar" })}
              LeadingIcon={BarChart}
              leadingIconClassName={
                config.chartType === "bar" ? "text-indigo-500" : "text-text-dimmed"
              }
            >
              <span className={config.chartType === "bar" ? "text-indigo-500" : "text-text-dimmed"}>
                Bar
              </span>
            </Button>
            <Button
              type="button"
              variant="tertiary/small"
              className={cn(
                "rounded-l-none border-b pl-1 pr-2",
                config.chartType === "line" ? "border-indigo-500" : "border-transparent"
              )}
              iconSpacing="gap-x-1"
              onClick={() => updateConfig({ chartType: "line" })}
              LeadingIcon={LineChart}
              leadingIconClassName={
                config.chartType === "line" ? "text-indigo-500" : "text-text-dimmed"
              }
            >
              <span
                className={config.chartType === "line" ? "text-indigo-500" : "text-text-dimmed"}
              >
                Line
              </span>
            </Button>
          </div>
        </ConfigField>
      </div>

      <div className="flex flex-col gap-2">
        {/* X-Axis */}
        <ConfigField label="X-Axis">
          <Select
            value={config.xAxisColumn ?? ""}
            setValue={(value) => {
              const updates: Partial<ChartConfiguration> = { xAxisColumn: value || null };
              // Auto-set sort to x-axis ASC if selecting a datetime column
              if (value) {
                const selectedCol = columns.find((c) => c.name === value);
                if (selectedCol && isDateTimeType(selectedCol.type)) {
                  updates.sortByColumn = value;
                  updates.sortDirection = "asc";
                }
              }
              updateConfig(updates);
            }}
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

        {/* Y-Axis / Series */}
        <ConfigField label={config.yAxisColumns.length > 1 ? "Series" : "Y-Axis"}>
          {yAxisOptions.length === 0 ? (
            <span className="text-xs text-text-dimmed">No numeric columns</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              {/* Always show at least one dropdown, even if yAxisColumns is empty */}
              {(config.yAxisColumns.length === 0 ? [""] : config.yAxisColumns).map(
                (col, index) => (
                  <div key={index} className="flex items-center gap-1">
                    <Select
                      value={col}
                      setValue={(value) => {
                        const newColumns = [...config.yAxisColumns];
                        if (value) {
                          // If this is a new slot (empty string), add it
                          if (index >= config.yAxisColumns.length) {
                            newColumns.push(value);
                          } else {
                            newColumns[index] = value;
                          }
                        } else if (index < config.yAxisColumns.length) {
                          newColumns.splice(index, 1);
                        }
                        updateConfig({ yAxisColumns: newColumns });
                      }}
                      variant="tertiary/small"
                      placeholder="Select column"
                      items={yAxisOptions.filter(
                        (opt) => opt.value === col || !config.yAxisColumns.includes(opt.value)
                      )}
                      dropdownIcon
                      className="min-w-[140px] flex-1"
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
                    {index > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const newColumns = config.yAxisColumns.filter((_, i) => i !== index);
                          updateConfig({ yAxisColumns: newColumns });
                        }}
                        className="rounded p-1 text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
                        title="Remove series"
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              )}

              {/* Add another series button - only show when we have at least one series and not grouped */}
              {config.yAxisColumns.length > 0 &&
                config.yAxisColumns.length < yAxisOptions.length &&
                !config.groupByColumn && (
                  <button
                    type="button"
                    onClick={() => {
                      const availableColumns = yAxisOptions.filter(
                        (opt) => !config.yAxisColumns.includes(opt.value)
                      );
                      if (availableColumns.length > 0) {
                        updateConfig({
                          yAxisColumns: [...config.yAxisColumns, availableColumns[0].value],
                        });
                      }
                    }}
                    className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
                  >
                    <Plus className="h-3 w-3" />
                    Add series
                  </button>
                )}

              {config.groupByColumn && config.yAxisColumns.length === 1 && (
                <span className="text-xxs text-text-dimmed">
                  Remove group by to add multiple series
                </span>
              )}
            </div>
          )}
        </ConfigField>

        {/* Aggregation */}
        <ConfigField label="Aggregation">
          <Select
            value={config.aggregation}
            setValue={(value) => updateConfig({ aggregation: value as AggregationType })}
            variant="tertiary/small"
            items={aggregationOptions}
            dropdownIcon
            className="min-w-[100px]"
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))
            }
          </Select>
        </ConfigField>

        {/* Group By - disabled when multiple series are selected */}
        <ConfigField label="Group by">
          {config.yAxisColumns.length > 1 ? (
            <span className="text-xs text-text-dimmed">
              Not available with multiple series
            </span>
          ) : (
            <Select
              value={config.groupByColumn ?? "__none__"}
              setValue={(value) =>
                updateConfig({ groupByColumn: value === "__none__" ? null : value })
              }
              variant="tertiary/small"
              placeholder="None"
              items={groupByOptions}
              dropdownIcon
              className="min-w-[140px]"
              text={(t) => (t === "__none__" ? "None" : t)}
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
          )}
        </ConfigField>

        {/* Stacked toggle (when grouped or multiple series) */}
        {(config.groupByColumn || config.yAxisColumns.length > 1) && (
          <ConfigField label={config.groupByColumn ? "Stack groups" : "Stack series"}>
            <Switch
              variant="medium"
              checked={config.stacked}
              onCheckedChange={(checked) => updateConfig({ stacked: checked })}
            />
          </ConfigField>
        )}

        {/* Order By */}
        <ConfigField label="Order by">
          <Select
            value={config.sortByColumn ?? "__none__"}
            setValue={(value) =>
              updateConfig({ sortByColumn: value === "__none__" ? null : value })
            }
            variant="tertiary/small"
            placeholder="None"
            items={sortByOptions}
            dropdownIcon
            className="min-w-[140px]"
            text={(t) => (t === "__none__" ? "None" : t)}
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

        {/* Sort Direction (only when sorting) */}
        {config.sortByColumn && (
          <ConfigField label="Sort direction">
            <SortDirectionToggle
              direction={config.sortDirection}
              onChange={(direction) => updateConfig({ sortDirection: direction })}
            />
          </ConfigField>
        )}
      </div>
    </div>
  );
}

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-xs text-text-dimmed">{label}</span>}
      {children}
    </div>
  );
}

function SortDirectionToggle({
  direction,
  onChange,
}: {
  direction: SortDirection;
  onChange: (direction: SortDirection) => void;
}) {
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={() => onChange("asc")}
        className={cn(
          "rounded px-2 py-1 text-xs transition-colors",
          direction === "asc"
            ? "bg-charcoal-700 text-text-bright"
            : "text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright"
        )}
        title="Ascending"
      >
        Asc
      </button>
      <button
        type="button"
        onClick={() => onChange("desc")}
        className={cn(
          "rounded px-2 py-1 text-xs transition-colors",
          direction === "desc"
            ? "bg-charcoal-700 text-text-bright"
            : "text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright"
        )}
        title="Descending"
      >
        Desc
      </button>
    </div>
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
