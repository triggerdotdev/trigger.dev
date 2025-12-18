import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import type { TaskRunStatus } from "@trigger.dev/database";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { formatCurrencyAccurate, formatNumber } from "~/utils/numberFormatter";
import type { ColumnMetadata } from "~/utils/tsqlColumns";
import { allTaskRunStatuses, TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";

/**
 * Check if a value is a valid TaskRunStatus
 */
function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return typeof value === "string" && allTaskRunStatuses.includes(value as TaskRunStatus);
}

/**
 * Render a cell value based on its render type
 */
function CellValue({ value, column }: { value: unknown; column: ColumnMetadata }) {
  // Handle null/undefined values
  if (value === null || value === undefined) {
    return <span className="text-text-dimmed">–</span>;
  }

  // Render based on the column's render type
  switch (column.renderType) {
    case "runStatus":
      if (isTaskRunStatus(value)) {
        return <TaskRunStatusCombo status={value} />;
      }
      // Fall back to string if not a valid status
      return <span>{String(value)}</span>;

    case "datetime":
      if (typeof value === "string") {
        return <DateTime date={value} />;
      }
      return <span>{String(value)}</span>;

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

    case "boolean":
      // Handle both actual booleans and 0/1 numbers
      if (typeof value === "boolean") {
        return <span className="text-text-dimmed">{value ? "true" : "false"}</span>;
      }
      if (typeof value === "number") {
        return <span className="text-text-dimmed">{value === 1 ? "true" : "false"}</span>;
      }
      return <span>{String(value)}</span>;

    case "json":
    case "array":
      return <span className="font-mono text-xs text-text-dimmed">{JSON.stringify(value)}</span>;

    case "number":
      if (typeof value === "number") {
        return <span className="tabular-nums">{formatNumber(value)}</span>;
      }
      return <span>{String(value)}</span>;

    case "string":
    default:
      return <span>{String(value)}</span>;
  }
}

export function TSQLResultsTable({
  rows,
  columns,
}: {
  rows: Record<string, unknown>[];
  columns: ColumnMetadata[];
}) {
  if (!rows.length || !columns.length) return null;

  return (
    <Table fullWidth>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHeaderCell key={col.name}>{col.name}</TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            {columns.map((col) => (
              <TableCell key={col.name}>
                <CellValue value={row[col.name]} column={col} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
