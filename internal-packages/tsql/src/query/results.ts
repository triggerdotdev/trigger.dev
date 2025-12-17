/**
 * Result transformation utilities for TSQL queries
 *
 * Transforms query result values from internal ClickHouse values
 * to user-friendly display names using the column valueMap.
 */

import type { TableSchema, ColumnSchema } from "./schema.js";
import { getUserFriendlyValue } from "./schema.js";

/**
 * Options for transforming query results
 */
export interface TransformResultsOptions {
  /**
   * If true, transform values even if the column was aliased (e.g., SELECT status AS s)
   * Default: false (aliased columns are not transformed since the user explicitly chose a different name)
   */
  transformAliased?: boolean;
}

/**
 * Transform query result rows, mapping internal values to user-friendly display names
 *
 * This function iterates over result rows and transforms any column values that have
 * a `valueMap` defined in their schema, converting internal ClickHouse values
 * (e.g., 'COMPLETED_SUCCESSFULLY') back to user-friendly display names (e.g., 'Completed').
 *
 * @param rows - Array of result rows to transform
 * @param schema - Array of table schemas containing column definitions with valueMaps
 * @param options - Optional transformation options
 * @returns New array of rows with transformed values
 *
 * @example
 * ```typescript
 * const schema: TableSchema[] = [{
 *   name: "task_runs",
 *   clickhouseName: "trigger_dev.task_runs_v2",
 *   columns: {
 *     status: {
 *       name: "status",
 *       type: "String",
 *       valueMap: {
 *         "COMPLETED_SUCCESSFULLY": "Completed",
 *         "PENDING": "Pending",
 *       },
 *     },
 *   },
 *   tenantColumns: { organizationId: "organization_id", projectId: "project_id", environmentId: "environment_id" },
 * }];
 *
 * const results = [{ status: "COMPLETED_SUCCESSFULLY", run_id: "run_123" }];
 * const transformed = transformResults(results, schema);
 * // transformed = [{ status: "Completed", run_id: "run_123" }]
 * ```
 */
export function transformResults<T extends Record<string, unknown>>(
  rows: T[],
  schema: TableSchema[],
  options: TransformResultsOptions = {}
): T[] {
  // Build a map of column names to their schemas (for columns that have valueMaps)
  const columnValueMaps = buildColumnValueMaps(schema);

  // If no columns have valueMaps, return the original rows unchanged
  if (columnValueMaps.size === 0) {
    return rows;
  }

  // Transform each row
  return rows.map((row) => transformRow(row, columnValueMaps));
}

/**
 * Build a map of column names to their schemas for columns that have valueMaps
 */
function buildColumnValueMaps(schema: TableSchema[]): Map<string, ColumnSchema> {
  const columnMaps = new Map<string, ColumnSchema>();

  for (const table of schema) {
    for (const [columnName, columnSchema] of Object.entries(table.columns)) {
      if (columnSchema.valueMap && Object.keys(columnSchema.valueMap).length > 0) {
        // Use the TSQL-exposed column name (not the ClickHouse name)
        columnMaps.set(columnName, columnSchema);
      }
    }
  }

  return columnMaps;
}

/**
 * Transform a single row's values using the column valueMaps
 */
function transformRow<T extends Record<string, unknown>>(
  row: T,
  columnValueMaps: Map<string, ColumnSchema>
): T {
  const transformedRow: Record<string, unknown> = {};
  let hasChanges = false;

  for (const [key, value] of Object.entries(row)) {
    const columnSchema = columnValueMaps.get(key);

    if (columnSchema && typeof value === "string") {
      const transformedValue = getUserFriendlyValue(columnSchema, value);
      transformedRow[key] = transformedValue;
      if (transformedValue !== value) {
        hasChanges = true;
      }
    } else {
      transformedRow[key] = value;
    }
  }

  // Return original row if no changes were made (preserves reference equality)
  return hasChanges ? (transformedRow as T) : row;
}

/**
 * Create a result transformer bound to a specific schema
 *
 * Useful when you need to transform multiple result sets with the same schema.
 *
 * @param schema - Array of table schemas
 * @param options - Optional transformation options
 * @returns A function that transforms result rows
 *
 * @example
 * ```typescript
 * const transform = createResultTransformer(schema);
 *
 * const results1 = await query1();
 * const transformed1 = transform(results1);
 *
 * const results2 = await query2();
 * const transformed2 = transform(results2);
 * ```
 */
export function createResultTransformer(
  schema: TableSchema[],
  options: TransformResultsOptions = {}
): <T extends Record<string, unknown>>(rows: T[]) => T[] {
  const columnValueMaps = buildColumnValueMaps(schema);

  return <T extends Record<string, unknown>>(rows: T[]): T[] => {
    if (columnValueMaps.size === 0) {
      return rows;
    }
    return rows.map((row) => transformRow(row, columnValueMaps));
  };
}

