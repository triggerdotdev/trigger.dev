import { formatDurationMilliseconds, MachinePresetName } from "@trigger.dev/core/v3";
import type { OutputColumnMetadata } from "@internal/clickhouse";
import { DateTime } from "~/components/primitives/DateTime";
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
  return (
    type === "Bool" || type === "UInt8" || type === "Nullable(Bool)" || type === "Nullable(UInt8)"
  );
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
  // Plain text mode - render everything as monospace text
  if (!prettyFormatting) {
    return <pre className="font-mono text-xs">{value === null ? "NULL" : String(value)}</pre>;
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
    }
  }

  // Fall back to rendering based on ClickHouse type
  const { type } = column;

  // DateTime types
  if (isDateTimeType(type)) {
    if (typeof value === "string") {
      return <DateTime date={value} />;
    }
    return <span>{String(value)}</span>;
  }

  // JSON type
  if (type === "JSON") {
    return <span className="font-mono text-xs text-text-dimmed">{JSON.stringify(value)}</span>;
  }

  // Array types
  if (type.startsWith("Array")) {
    return <span className="font-mono text-xs text-text-dimmed">{JSON.stringify(value)}</span>;
  }

  // Boolean-like types (UInt8 is commonly used for booleans in ClickHouse)
  if (isBooleanType(type)) {
    if (typeof value === "boolean") {
      return <span className="text-text-dimmed">{value ? "true" : "false"}</span>;
    }
    if (typeof value === "number") {
      return <span className="text-text-dimmed">{value === 1 ? "true" : "false"}</span>;
    }
    return <span>{String(value)}</span>;
  }

  // Numeric types (excluding UInt8 which is handled as boolean above)
  if (isNumericType(type) && type !== "UInt8" && type !== "Nullable(UInt8)") {
    if (typeof value === "number") {
      return <span className="tabular-nums">{formatNumber(value)}</span>;
    }
    return <span>{String(value)}</span>;
  }

  // Default to string rendering
  return <span>{String(value)}</span>;
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
    column.customRenderType === "cost" ||
    column.customRenderType === "costInDollars"
  ) {
    return true;
  }

  // Check for numeric types (excluding UInt8 which is often used for booleans)
  const { type } = column;
  if (type === "UInt8" || type === "Nullable(UInt8)") {
    return false;
  }

  return isNumericType(type);
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
    <Table fullWidth>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHeaderCell
              key={col.name}
              alignment={isRightAlignedColumn(col) ? "right" : "left"}
            >
              {col.description ? (
                <SimpleTooltip
                  content={col.description}
                  disableHoverableContent
                  button={
                    <span className="inline-flex items-center gap-1">
                      {col.name}
                      <InformationCircleIcon className="size-4 text-text-dimmed" />
                    </span>
                  }
                />
              ) : (
                col.name
              )}
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
                  value={String(row[col.name])}
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
