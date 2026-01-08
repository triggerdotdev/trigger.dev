import { formatDurationMilliseconds, MachinePresetName } from "@trigger.dev/core/v3";
import type { OutputColumnMetadata } from "@internal/clickhouse";
import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import {
  CopyableTableCell,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { formatCurrencyAccurate, formatNumber } from "~/utils/numberFormatter";
import {
  descriptionForTaskRunStatus,
  isRunFriendlyStatus,
  isTaskRunStatus,
  runStatusFromFriendlyTitle,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { Paragraph } from "../primitives/Paragraph";
import { TextLink } from "../primitives/TextLink";
import { v3ProjectPath, v3RunPathFromFriendlyId } from "~/utils/pathBuilder";
import { SimpleTooltip } from "../primitives/Tooltip";
import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { QueueName } from "../runs/v3/QueueName";

const MAX_STRING_DISPLAY_LENGTH = 64;

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
 * Render a cell value based on its type and optional customRenderType
 */
function CellValue({
  value,
  column,
  prettyFormatting = true,
}: {
  value: unknown;
  column: OutputColumnMetadata;
  prettyFormatting?: boolean;
}) {
  // Plain text mode - render everything as monospace text with truncation
  if (!prettyFormatting) {
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
        // We have mapped the status to a friendly status so we need to map back to render the normal component
        const status = isTaskRunStatus(value)
          ? value
          : isRunFriendlyStatus(value)
          ? runStatusFromFriendlyTitle(value)
          : undefined;
        if (status) {
          return (
            <SimpleTooltip
              content={descriptionForTaskRunStatus(status)}
              disableHoverableContent
              button={<TaskRunStatusCombo status={status} />}
            />
          );
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
          // Assume cost values are in cents
          return <span className="tabular-nums">{formatCurrencyAccurate(value / 100)}</span>;
        }
        return <span>{String(value)}</span>;
      case "costInDollars":
        if (typeof value === "number") {
          // Value is already in dollars, no conversion needed
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
            <EnvironmentCombo
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

  // DateTime types
  if (isDateTimeType(type)) {
    if (typeof value === "string") {
      return <DateTimeAccurate date={value} />;
    }
    return <span>{String(value)}</span>;
  }

  // JSON type
  if (type === "JSON") {
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

  // Array types
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

  // Boolean types
  if (isBooleanType(type)) {
    if (typeof value === "boolean") {
      return <span className="text-text-dimmed">{value ? "true" : "false"}</span>;
    }
    if (typeof value === "number") {
      return <span className="text-text-dimmed">{value === 1 ? "true" : "false"}</span>;
    }
    return <span>{String(value)}</span>;
  }

  // Numeric types
  if (isNumericType(type)) {
    if (typeof value === "number") {
      return <span className="tabular-nums">{formatNumber(value)}</span>;
    }
    return <span>{String(value)}</span>;
  }

  // Default to string rendering with truncation for long values
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

  return <EnvironmentCombo environment={environment} />;
}

/**
 * Check if a column should be right-aligned (numeric columns, duration, cost)
 */
function isRightAlignedColumn(column: OutputColumnMetadata): boolean {
  // Check for custom render types that display numeric values
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

export function TSQLResultsTable({
  rows,
  columns,
  prettyFormatting = true,
}: {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  prettyFormatting?: boolean;
}) {
  if (!columns.length) return null;

  return (
    <Table fullWidth containerClassName="h-full overflow-y-auto border-t-0">
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHeaderCell
              key={col.name}
              alignment={isRightAlignedColumn(col) ? "right" : "left"}
              tooltip={col.description}
            >
              {col.name}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length}>
              <Paragraph variant="extra-small" className="p-2 text-text-dimmed">
                No results
              </Paragraph>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((col) => (
                <CopyableTableCell
                  key={col.name}
                  alignment={isRightAlignedColumn(col) ? "right" : "left"}
                  value={valueToString(row[col.name])}
                >
                  <span className="flex-1">
                    <CellValue
                      value={row[col.name]}
                      column={col}
                      prettyFormatting={prettyFormatting}
                    />
                  </span>
                </CopyableTableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
