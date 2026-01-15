import type { OutputColumnMetadata } from "@internal/clickhouse";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type CellContext,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDurationMilliseconds, MachinePresetName } from "@trigger.dev/core/v3";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import {
  descriptionForTaskRunStatus,
  isRunFriendlyStatus,
  isTaskRunStatus,
  runStatusFromFriendlyTitle,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { useCopy } from "~/hooks/useCopy";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { formatCurrencyAccurate, formatNumber } from "~/utils/numberFormatter";
import { v3ProjectPath, v3RunPathFromFriendlyId } from "~/utils/pathBuilder";
import { Paragraph } from "../primitives/Paragraph";
import { TextLink } from "../primitives/TextLink";
import { InfoIconTooltip, SimpleTooltip } from "../primitives/Tooltip";
import { QueueName } from "../runs/v3/QueueName";

const MAX_STRING_DISPLAY_LENGTH = 64;
const ROW_HEIGHT = 33; // Estimated row height in pixels

// Column width calculation constants
const MIN_COLUMN_WIDTH = 60;
const MAX_COLUMN_WIDTH = 400;
const CHAR_WIDTH_PX = 7.5; // Approximate width of a monospace character at text-xs (12px)
const CELL_PADDING_PX = 40; // px-2 (8px) on each side + buffer for copy button
const SAMPLE_SIZE = 100; // Number of rows to sample for width calculation

// Type for row data
type RowData = Record<string, unknown>;

// Extended column meta to store OutputColumnMetadata
interface ColumnMeta {
  outputColumn: OutputColumnMetadata;
  alignment: "left" | "right";
}

/**
 * Get the approximate display length (in characters) of a value based on its type and formatting
 */
function getDisplayLength(value: unknown, column: OutputColumnMetadata): number {
  if (value === null) return 4; // "NULL"
  if (value === undefined) return 9; // "UNDEFINED"

  // Handle custom render types - estimate their rendered width
  if (column.customRenderType) {
    switch (column.customRenderType) {
      case "runId":
        // Run IDs are typically like "run_abc123xyz"
        return typeof value === "string" ? Math.min(value.length, MAX_STRING_DISPLAY_LENGTH) : 15;
      case "runStatus":
        // Status badges have icon + text, approximate width
        return 12;
      case "duration":
        if (typeof value === "number") {
          // Format and measure: "1h 23m 45s" style
          const formatted = formatDurationMilliseconds(value, { style: "short" });
          return formatted.length;
        }
        return 10;
      case "durationSeconds":
        if (typeof value === "number") {
          const formatted = formatDurationMilliseconds(value * 1000, { style: "short" });
          return formatted.length;
        }
        return 10;
      case "cost":
      case "costInDollars":
        // Currency format: "$1,234.56"
        if (typeof value === "number") {
          const amount = column.customRenderType === "cost" ? value / 100 : value;
          return formatCurrencyAccurate(amount).length;
        }
        return 12;
      case "machine":
        // Machine preset names like "small-1x"
        return typeof value === "string" ? value.length : 10;
      case "environmentType":
        // Environment labels: "PRODUCTION", "STAGING", etc.
        return 12;
      case "project":
      case "environment":
        return typeof value === "string" ? Math.min(value.length, 20) : 12;
      case "queue":
        return typeof value === "string" ? Math.min(value.length, 25) : 15;
    }
  }

  // Handle by ClickHouse type
  if (isDateTimeType(column.type)) {
    // DateTime format: "Jan 15, 2026, 12:34:56 PM"
    return 24;
  }

  if (column.type === "JSON" || column.type.startsWith("Array")) {
    if (typeof value === "object") {
      const jsonStr = JSON.stringify(value);
      return Math.min(jsonStr.length, MAX_STRING_DISPLAY_LENGTH);
    }
  }

  if (isBooleanType(column.type)) {
    return 5; // "true" or "false"
  }

  if (isNumericType(column.type)) {
    if (typeof value === "number") {
      return formatNumber(value).length;
    }
  }

  // Default: string length capped at max display length
  const strValue = String(value);
  return Math.min(strValue.length, MAX_STRING_DISPLAY_LENGTH);
}

/**
 * Calculate the optimal width for a column based on its content
 */
function calculateColumnWidth(
  columnName: string,
  rows: RowData[],
  column: OutputColumnMetadata
): number {
  // Start with header length
  let maxLength = columnName.length;

  // Sample rows to find max content length
  const sampleRows = rows.slice(0, SAMPLE_SIZE);
  for (const row of sampleRows) {
    const value = row[columnName];
    const displayLength = getDisplayLength(value, column);
    if (displayLength > maxLength) {
      maxLength = displayLength;
    }
  }

  // Calculate pixel width: characters * char width + padding
  const calculatedWidth = Math.ceil(maxLength * CHAR_WIDTH_PX + CELL_PADDING_PX);

  // Apply min/max bounds
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, calculatedWidth));
}

/**
 * Truncate a string for display, adding ellipsis if it exceeds max length
 */
function truncateString(value: string, maxLength: number = MAX_STRING_DISPLAY_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength) + "…";
}

/**
 * Convert any value to a string suitable for copying
 * Objects and arrays are JSON stringified, primitives use String()
 */
function valueToString(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "UNDEFINED";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Check if a ClickHouse type is a DateTime type
 */
function isDateTimeType(type: string): boolean {
  return (
    type === "DateTime" ||
    type === "DateTime64" ||
    type === "Date" ||
    type === "Date32" ||
    type.startsWith("Nullable(DateTime") ||
    type.startsWith("Nullable(Date")
  );
}

/**
 * Check if a ClickHouse type is a numeric type
 */
function isNumericType(type: string): boolean {
  return (
    type.startsWith("Int") ||
    type.startsWith("UInt") ||
    type.startsWith("Float") ||
    type.startsWith("Nullable(Int") ||
    type.startsWith("Nullable(UInt") ||
    type.startsWith("Nullable(Float")
  );
}

/**
 * Check if a ClickHouse type is a boolean type
 */
function isBooleanType(type: string): boolean {
  return type === "Bool" || type === "Nullable(Bool)";
}

/**
 * Check if a column should be right-aligned (numeric columns, duration, cost)
 */
function isRightAlignedColumn(column: OutputColumnMetadata): boolean {
  if (
    column.customRenderType === "duration" ||
    column.customRenderType === "durationSeconds" ||
    column.customRenderType === "cost" ||
    column.customRenderType === "costInDollars"
  ) {
    return true;
  }
  return isNumericType(column.type);
}

/**
 * Wrapper component that tracks hover state and passes it to CellValue
 * This optimizes rendering by only enabling tooltips when the cell is hovered
 */
function CellValueWrapper({
  value,
  column,
  prettyFormatting,
}: {
  value: unknown;
  column: OutputColumnMetadata;
  prettyFormatting: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <span
      className="flex-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <CellValue
        value={value}
        column={column}
        prettyFormatting={prettyFormatting}
        hovered={hovered}
      />
    </span>
  );
}

/**
 * Render a cell value based on its type and optional customRenderType
 */
function CellValue({
  value,
  column,
  prettyFormatting = true,
  hovered = false,
}: {
  value: unknown;
  column: OutputColumnMetadata;
  prettyFormatting?: boolean;
  hovered?: boolean;
}) {
  // Plain text mode - render everything as monospace text with truncation
  if (!prettyFormatting) {
    if (column.type === "JSON") {
      return <JSONCellValue value={value} />;
    }

    const plainValue = value === null ? "NULL" : String(value);
    const isTruncated = plainValue.length > MAX_STRING_DISPLAY_LENGTH;

    if (isTruncated) {
      return (
        <SimpleTooltip
          content={
            <pre className="max-w-sm whitespace-pre-wrap break-all font-mono text-xs">
              {plainValue}
            </pre>
          }
          button={<pre className="font-mono text-xs">{truncateString(plainValue)}</pre>}
        />
      );
    }

    return <pre className="font-mono text-xs">{plainValue}</pre>;
  }

  if (value === null) {
    return <pre className="text-text-dimmed">NULL</pre>;
  }

  if (value === undefined) {
    return <pre className="text-text-dimmed">UNDEFINED</pre>;
  }

  // First check customRenderType for special rendering
  if (column.customRenderType) {
    switch (column.customRenderType) {
      case "runId": {
        if (typeof value === "string") {
          return <TextLink to={v3RunPathFromFriendlyId(value)}>{value}</TextLink>;
        }
        break;
      }
      case "runStatus": {
        const status = isTaskRunStatus(value)
          ? value
          : isRunFriendlyStatus(value)
          ? runStatusFromFriendlyTitle(value)
          : undefined;
        if (status) {
          if (hovered) {
            return (
              <SimpleTooltip
                content={descriptionForTaskRunStatus(status)}
                disableHoverableContent
                button={<TaskRunStatusCombo status={status} />}
              />
            );
          }
          return <TaskRunStatusCombo status={status} />;
        }
        break;
      }
      case "duration":
        if (typeof value === "number") {
          return (
            <span className="tabular-nums">
              {formatDurationMilliseconds(value, { style: "short" })}
            </span>
          );
        }
        return <span>{String(value)}</span>;
      case "durationSeconds":
        if (typeof value === "number") {
          return (
            <span className="tabular-nums">
              {formatDurationMilliseconds(value * 1000, { style: "short" })}
            </span>
          );
        }
        return <span>{String(value)}</span>;
      case "cost":
        if (typeof value === "number") {
          return <span className="tabular-nums">{formatCurrencyAccurate(value / 100)}</span>;
        }
        return <span>{String(value)}</span>;
      case "costInDollars":
        if (typeof value === "number") {
          return <span className="tabular-nums">{formatCurrencyAccurate(value)}</span>;
        }
        return <span>{String(value)}</span>;
      case "machine": {
        const preset = MachinePresetName.safeParse(value);
        if (preset.success) {
          return <MachineLabelCombo preset={preset.data} />;
        }
        return <span>{String(value)}</span>;
      }
      case "environmentType": {
        if (
          typeof value === "string" &&
          ["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"].includes(value)
        ) {
          return (
            <EnvironmentLabel
              environment={{ type: value as "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW" }}
            />
          );
        }
        return <span>{String(value)}</span>;
      }
      case "project": {
        if (typeof value === "string") {
          return <ProjectCellValue value={value} />;
        }
        return <span>{String(value)}</span>;
      }
      case "environment": {
        if (typeof value === "string") {
          return <EnvironmentCellValue value={value} />;
        }
        return <span>{String(value)}</span>;
      }
      case "queue": {
        if (typeof value === "string") {
          const type = value.startsWith("task/") ? "task" : "custom";
          return <QueueName type={type} name={value.replace("task/", "")} />;
        }
        return <span>{String(value)}</span>;
      }
    }
  }

  // Fall back to rendering based on ClickHouse type
  const { type } = column;

  if (isDateTimeType(type)) {
    if (typeof value === "string") {
      return <DateTimeAccurate date={value} showTooltip={hovered} />;
    }
    return <span>{String(value)}</span>;
  }

  if (type === "JSON") {
    return <JSONCellValue value={value} />;
  }

  if (type.startsWith("Array")) {
    const arrayString = JSON.stringify(value);
    const isTruncated = arrayString.length > MAX_STRING_DISPLAY_LENGTH;

    if (isTruncated) {
      return (
        <SimpleTooltip
          content={
            <pre className="max-w-sm whitespace-pre-wrap break-all font-mono text-xs">
              {arrayString}
            </pre>
          }
          button={
            <span className="font-mono text-xs text-text-dimmed">
              {truncateString(arrayString)}
            </span>
          }
        />
      );
    }
    return <span className="font-mono text-xs text-text-dimmed">{arrayString}</span>;
  }

  if (isBooleanType(type)) {
    if (typeof value === "boolean") {
      return <span className="text-text-dimmed">{value ? "true" : "false"}</span>;
    }
    if (typeof value === "number") {
      return <span className="text-text-dimmed">{value === 1 ? "true" : "false"}</span>;
    }
    return <span>{String(value)}</span>;
  }

  if (isNumericType(type)) {
    if (typeof value === "number") {
      return <span className="tabular-nums">{formatNumber(value)}</span>;
    }
    return <span>{String(value)}</span>;
  }

  const stringValue = String(value);
  const isTruncated = stringValue.length > MAX_STRING_DISPLAY_LENGTH;

  if (isTruncated) {
    return (
      <SimpleTooltip
        content={
          <pre className="max-w-sm whitespace-pre-wrap break-all font-mono text-xs">
            {stringValue}
          </pre>
        }
        button={<span>{truncateString(stringValue)}</span>}
      />
    );
  }

  return <span>{stringValue}</span>;
}

function ProjectCellValue({ value }: { value: string }) {
  const organization = useOrganization();
  const project = organization.projects.find((p) => p.externalRef === value);

  if (!project) {
    return <span>{value}</span>;
  }

  return <TextLink to={v3ProjectPath(organization, project)}>{project.name}</TextLink>;
}

function EnvironmentCellValue({ value }: { value: string }) {
  const project = useProject();
  const environment = project.environments.find((e) => e.slug === value);

  if (!environment) {
    return <span>{value}</span>;
  }

  return <EnvironmentLabel environment={environment} />;
}

function JSONCellValue({ value }: { value: unknown }) {
  const jsonString = JSON.stringify(value);
  const isTruncated = jsonString.length > MAX_STRING_DISPLAY_LENGTH;

  if (isTruncated) {
    return (
      <SimpleTooltip
        content={
          <pre className="max-w-sm whitespace-pre-wrap break-all font-mono text-xs">
            {jsonString}
          </pre>
        }
        button={
          <span className="font-mono text-xs text-text-dimmed">{truncateString(jsonString)}</span>
        }
      />
    );
  }

  return <span className="font-mono text-xs text-text-dimmed">{jsonString}</span>;
}

/**
 * Copyable cell component for virtualized rows
 */
function CopyableCell({
  value,
  alignment,
  children,
}: {
  value: string;
  alignment: "left" | "right";
  children: React.ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const { copy, copied } = useCopy(value);

  return (
    <div
      className={cn(
        "relative flex w-full items-center px-2 py-1.5",
        "font-mono text-xs text-text-dimmed group-hover/row:text-text-bright",
        alignment === "right" && "justify-end"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
      {isHovered && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            copy();
          }}
          className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 cursor-pointer"
        >
          <SimpleTooltip
            button={
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded border border-charcoal-650 bg-charcoal-750",
                  copied
                    ? "text-green-500"
                    : "text-text-dimmed hover:border-charcoal-600 hover:bg-charcoal-700 hover:text-text-bright"
                )}
              >
                {copied ? (
                  <ClipboardCheckIcon className="size-3.5" />
                ) : (
                  <ClipboardIcon className="size-3.5" />
                )}
              </span>
            }
            content={copied ? "Copied!" : "Copy"}
            disableHoverableContent
          />
        </span>
      )}
    </div>
  );
}

/**
 * Header cell component with tooltip support
 */
function HeaderCellContent({
  alignment,
  tooltip,
  children,
}: {
  alignment: "left" | "right";
  tooltip?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={cn(
        "flex items-center px-2 py-1.5",
        "text-sm font-medium text-text-bright",
        alignment === "right" && "justify-end"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {tooltip ? (
        <div
          className={cn("flex items-center gap-1", {
            "justify-end": alignment === "right",
          })}
        >
          {children}
          <InfoIconTooltip
            content={tooltip}
            contentClassName="normal-case tracking-normal"
            enabled={isHovered}
          />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export const TSQLResultsTable = memo(function TSQLResultsTable({
  rows,
  columns,
  prettyFormatting = true,
}: {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  prettyFormatting?: boolean;
}) {
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Create TanStack Table column definitions from OutputColumnMetadata
  // Calculate column widths based on content
  const columnDefs = useMemo<ColumnDef<RowData, unknown>[]>(
    () =>
      columns.map((col) => ({
        id: col.name,
        accessorKey: col.name,
        header: () => col.name,
        cell: (info: CellContext<RowData, unknown>) => (
          <CellValueWrapper
            value={info.getValue()}
            column={col}
            prettyFormatting={prettyFormatting}
          />
        ),
        meta: {
          outputColumn: col,
          alignment: isRightAlignedColumn(col) ? "right" : "left",
        } as ColumnMeta,
        size: calculateColumnWidth(col.name, rows, col),
      })),
    [columns, rows, prettyFormatting]
  );

  // Initialize TanStack Table
  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
  });

  const { rows: tableRows } = table.getRowModel();

  // Set up the virtualizer
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    estimateSize: () => ROW_HEIGHT,
    getScrollElement: () => tableContainerRef.current,
    overscan: 5,
  });

  if (!columns.length) return null;

  // Empty state
  if (rows.length === 0) {
    return (
      <div
        className="h-full w-full overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        style={{ position: "relative" }}
      >
        <table style={{ display: "grid" }}>
          <thead
            className="bg-background-dimmed"
            style={{
              display: "grid",
              position: "sticky",
              top: 0,
              zIndex: 1,
            }}
          >
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} style={{ display: "flex", width: "100%" }}>
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta as ColumnMeta | undefined;
                  return (
                    <th
                      key={header.id}
                      style={{
                        display: "flex",
                        width: header.getSize(),
                      }}
                    >
                      <HeaderCellContent
                        alignment={meta?.alignment ?? "left"}
                        tooltip={meta?.outputColumn.description}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </HeaderCellContent>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody style={{ display: "grid" }}>
            <tr style={{ display: "flex" }}>
              <td>
                <Paragraph variant="extra-small" className="p-4 text-text-dimmed">
                  No results
                </Paragraph>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div
      ref={tableContainerRef}
      className="h-full w-full overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      style={{ position: "relative" }}
    >
      <table style={{ display: "grid" }}>
        <thead
          className="bg-background-dimmed after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright"
          style={{
            display: "grid",
            position: "sticky",
            top: 0,
            zIndex: 1,
          }}
        >
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} style={{ display: "flex", width: "100%" }}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta as ColumnMeta | undefined;
                return (
                  <th
                    key={header.id}
                    style={{
                      display: "flex",
                      width: header.getSize(),
                    }}
                  >
                    <HeaderCellContent
                      alignment={meta?.alignment ?? "left"}
                      tooltip={meta?.outputColumn.description}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </HeaderCellContent>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody
          style={{
            display: "grid",
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = tableRows[virtualRow.index];
            return (
              <tr
                key={row.id}
                data-index={virtualRow.index}
                className="group/row hover:bg-charcoal-800"
                style={{
                  display: "flex",
                  position: "absolute",
                  transform: `translateY(${virtualRow.start}px)`,
                  width: "100%",
                }}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as ColumnMeta | undefined;
                  return (
                    <td
                      key={cell.id}
                      style={{
                        display: "flex",
                        width: cell.column.getSize(),
                      }}
                    >
                      <CopyableCell
                        alignment={meta?.alignment ?? "left"}
                        value={valueToString(cell.getValue())}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </CopyableCell>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
