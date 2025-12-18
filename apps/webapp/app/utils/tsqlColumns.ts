/**
 * TSQL Column Metadata Inference
 *
 * Utilities for inferring column types and render types from query results.
 * This enables the UI to render values with appropriate components based on
 * column names and inferred types.
 */

/**
 * JavaScript types that can be inferred from values
 */
export type JSType = "string" | "number" | "boolean" | "object" | "array" | "null";

/**
 * Render types that determine how values should be displayed in the UI
 */
export type RenderType =
  | "string"
  | "number"
  | "boolean"
  | "datetime"
  | "json"
  | "array"
  | "runStatus"
  | "duration"
  | "cost";

/**
 * Metadata for a single column in query results
 */
export interface ColumnMetadata {
  /** Column name as it appears in the result */
  name: string;
  /** Inferred JavaScript type */
  jsType: JSType;
  /** Render type for UI display */
  renderType: RenderType;
}

/**
 * Check if a string looks like an ISO 8601 date
 */
function isISODateString(value: string): boolean {
  // Match ISO 8601 date formats: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;
  if (!isoDateRegex.test(value)) return false;
  const date = new Date(value);
  return !isNaN(date.getTime());
}

/**
 * Infer the JavaScript type from a value
 */
function inferJSType(value: unknown): JSType {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  return "string";
}

/**
 * Sample values from rows to get a non-null type
 * Returns the first non-null type found, or "null" if all values are null
 */
function sampleJSType(rows: Record<string, unknown>[], columnName: string): JSType {
  for (const row of rows) {
    const value = row[columnName];
    if (value !== null && value !== undefined) {
      return inferJSType(value);
    }
  }
  return "null";
}

/**
 * Check if all sampled string values look like ISO dates
 */
function allStringsAreDates(rows: Record<string, unknown>[], columnName: string): boolean {
  let foundString = false;
  for (const row of rows) {
    const value = row[columnName];
    if (typeof value === "string") {
      foundString = true;
      if (!isISODateString(value)) {
        return false;
      }
    }
  }
  return foundString;
}

/**
 * Check if all sampled number values are 0 or 1 (boolean-like)
 */
function allNumbersAreBooleanLike(rows: Record<string, unknown>[], columnName: string): boolean {
  let foundNumber = false;
  for (const row of rows) {
    const value = row[columnName];
    if (typeof value === "number") {
      foundNumber = true;
      if (value !== 0 && value !== 1) {
        return false;
      }
    }
  }
  return foundNumber;
}

/**
 * Derive the render type from column name and JS type
 *
 * Rules:
 * - Column named "status" with string type → "runStatus"
 * - ISO date strings → "datetime"
 * - is_* columns with 0/1 values → "boolean"
 * - *_duration_ms, *_duration columns → "duration"
 * - *_cost*, *_in_cents columns → "cost"
 * - Arrays → "array"
 * - Objects → "json"
 * - Numbers → "number"
 * - Default → "string"
 */
function deriveRenderType(
  columnName: string,
  jsType: JSType,
  rows: Record<string, unknown>[]
): RenderType {
  const lowerName = columnName.toLowerCase();

  // Status column with string type → runStatus
  if (lowerName === "status" && jsType === "string") {
    return "runStatus";
  }

  // Check for datetime strings
  if (jsType === "string" && allStringsAreDates(rows, columnName)) {
    return "datetime";
  }

  // Check for boolean-like columns (is_* pattern with 0/1 values)
  if (
    jsType === "number" &&
    lowerName.startsWith("is_") &&
    allNumbersAreBooleanLike(rows, columnName)
  ) {
    return "boolean";
  }

  // Duration columns
  if (
    jsType === "number" &&
    (lowerName.endsWith("_duration_ms") ||
      lowerName.endsWith("_duration") ||
      lowerName === "duration_ms" ||
      lowerName === "duration")
  ) {
    return "duration";
  }

  // Cost columns
  if (
    jsType === "number" &&
    (lowerName.includes("cost") || lowerName.endsWith("_in_cents") || lowerName === "in_cents")
  ) {
    return "cost";
  }

  // Arrays
  if (jsType === "array") {
    return "array";
  }

  // Objects (JSON)
  if (jsType === "object") {
    return "json";
  }

  // Numbers
  if (jsType === "number") {
    return "number";
  }

  // Boolean
  if (jsType === "boolean") {
    return "boolean";
  }

  // Default to string
  return "string";
}

/**
 * Infer column metadata from query result rows
 *
 * @param rows - Array of result rows from the query
 * @returns Array of column metadata in the order columns appear
 *
 * @example
 * ```typescript
 * const rows = [
 *   { run_id: "run_123", status: "COMPLETED_SUCCESSFULLY", created_at: "2024-01-01T00:00:00Z" },
 *   { run_id: "run_456", status: "PENDING", created_at: "2024-01-02T00:00:00Z" },
 * ];
 *
 * const columns = inferColumnMetadata(rows);
 * // [
 * //   { name: "run_id", jsType: "string", renderType: "string" },
 * //   { name: "status", jsType: "string", renderType: "runStatus" },
 * //   { name: "created_at", jsType: "string", renderType: "datetime" },
 * // ]
 * ```
 */
export function inferColumnMetadata(rows: Record<string, unknown>[]): ColumnMetadata[] {
  if (rows.length === 0) {
    return [];
  }

  // Extract unique column names from all rows (preserving order from first row)
  const columnNames = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  return columnNames.map((name) => {
    const jsType = sampleJSType(rows, name);
    const renderType = deriveRenderType(name, jsType, rows);

    return {
      name,
      jsType,
      renderType,
    };
  });
}

function getColumnData(key: string, rows: Record<string, unknown>[]): unknown[] {
  let data: unknown[] = [];
  for (const row of rows) {
    const value = row[key];
    if (value !== null && value !== undefined) {
      data.push(value);
    }
  }
  return data;
}

/**
 * Get column metadata by name from an array of column metadata
 */
export function getColumnByName(
  columns: ColumnMetadata[],
  name: string
): ColumnMetadata | undefined {
  return columns.find((col) => col.name === name);
}
