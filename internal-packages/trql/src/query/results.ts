/**
 * Result transformation utilities for TRQL queries
 *
 * Transforms query result values from internal ClickHouse values
 * to user-friendly display names using the column valueMap or fieldMapping.
 */

import type { TableSchema, ColumnSchema, FieldMappings } from "./schema.js";
import { getUserFriendlyValue, hasFieldMapping, getExternalValue } from "./schema.js";

/**
 * Options for transforming query results
 */
export interface TransformResultsOptions {
  /**
   * If true, transform values even if the column was aliased (e.g., SELECT status AS s)
   * Default: false (aliased columns are not transformed since the user explicitly chose a different name)
   */
  transformAliased?: boolean;
  /**
   * Runtime field mappings for dynamic value translation.
   * Maps internal ClickHouse values to external user-facing values.
   * Values not found in the mapping will be returned as null.
   */
  fieldMappings?: FieldMappings;
}

/**
 * Transform query result rows, mapping internal values to user-friendly display names
 *
 * This function iterates over result rows and transforms any column values that have
 * a `valueMap` or `fieldMapping` defined in their schema, converting internal ClickHouse values
 * (e.g., 'COMPLETED_SUCCESSFULLY') back to user-friendly display names (e.g., 'Completed').
 *
 * For columns with `fieldMapping`, values not found in the mapping will be returned as null.
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
 *     project_ref: {
 *       name: "project_ref",
 *       clickhouseName: "project_id",
 *       type: "String",
 *       fieldMapping: "project",
 *     },
 *   },
 *   tenantColumns: { organizationId: "organization_id", projectId: "project_id", environmentId: "environment_id" },
 * }];
 *
 * const results = [{ status: "COMPLETED_SUCCESSFULLY", project_ref: "cm12345" }];
 * const transformed = transformResults(results, schema, {
 *   fieldMappings: { project: { "cm12345": "my-project-ref" } },
 * });
 * // transformed = [{ status: "Completed", project_ref: "my-project-ref" }]
 * ```
 */
export function transformResults<T extends Record<string, unknown>>(
  rows: T[],
  schema: TableSchema[],
  options: TransformResultsOptions = {}
): T[] {
  // Build a map of column names to their schemas (for columns that have transformations)
  const columnTransformMaps = buildColumnTransformMaps(schema);

  // If no columns have transformations, return the original rows unchanged
  if (columnTransformMaps.size === 0) {
    return rows;
  }

  // Transform each row
  return rows.map((row) => transformRow(row, columnTransformMaps, options.fieldMappings));
}

/**
 * Build a map of column names to their schemas for columns that have transformations
 * (either valueMap or fieldMapping)
 */
function buildColumnTransformMaps(schema: TableSchema[]): Map<string, ColumnSchema> {
  const columnMaps = new Map<string, ColumnSchema>();

  for (const table of schema) {
    for (const [columnName, columnSchema] of Object.entries(table.columns)) {
      const hasValueMap = columnSchema.valueMap && Object.keys(columnSchema.valueMap).length > 0;
      const hasFieldMap = hasFieldMapping(columnSchema);

      if (hasValueMap || hasFieldMap) {
        // Use the TRQL-exposed column name (not the ClickHouse name)
        columnMaps.set(columnName, columnSchema);
      }
    }
  }

  return columnMaps;
}

/**
 * Transform a single value using the column's valueMap or fieldMapping
 * Returns the transformed value, or the original value if no transformation applies
 * For fieldMapping, returns null if the value is not found in the mapping
 */
function transformSingleValue(
  columnSchema: ColumnSchema,
  value: string,
  fieldMappings?: FieldMappings
): string | null {
  // First try static valueMap (always returns the original if no match)
  if (columnSchema.valueMap && Object.keys(columnSchema.valueMap).length > 0) {
    return getUserFriendlyValue(columnSchema, value);
  }

  // Then try runtime fieldMapping (returns null if not found)
  if (hasFieldMapping(columnSchema) && columnSchema.fieldMapping && fieldMappings) {
    const externalValue = getExternalValue(fieldMappings, columnSchema.fieldMapping, value);
    // For fieldMapping, return null if not found (per user requirement)
    return externalValue;
  }

  return value;
}

/**
 * Transform a single row's values using the column valueMaps and fieldMappings
 */
function transformRow<T extends Record<string, unknown>>(
  row: T,
  columnTransformMaps: Map<string, ColumnSchema>,
  fieldMappings?: FieldMappings
): T {
  const transformedRow: Record<string, unknown> = {};
  let hasChanges = false;

  for (const [key, value] of Object.entries(row)) {
    const columnSchema = columnTransformMaps.get(key);

    if (columnSchema && typeof value === "string") {
      const transformedValue = transformSingleValue(columnSchema, value, fieldMappings);
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
 * @param options - Optional transformation options (including fieldMappings)
 * @returns A function that transforms result rows
 *
 * @example
 * ```typescript
 * const transform = createResultTransformer(schema, {
 *   fieldMappings: { project: { "cm12345": "my-project-ref" } },
 * });
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
  const columnTransformMaps = buildColumnTransformMaps(schema);

  return <T extends Record<string, unknown>>(rows: T[]): T[] => {
    if (columnTransformMaps.size === 0) {
      return rows;
    }
    return rows.map((row) => transformRow(row, columnTransformMaps, options.fieldMappings));
  };
}

