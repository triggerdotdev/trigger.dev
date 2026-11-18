import type { OutputColumnMetadata } from "@internal/clickhouse";

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export function escapeCSVCell(value: string): string {
  const safe = FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function escapeCSVValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return escapeCSVCell(typeof value === "object" ? JSON.stringify(value) : String(value));
}

/**
 * Convert query result rows to CSV format.
 *
 * @param rows - Array of row objects from query results
 * @param columns - Column metadata describing the result columns
 * @returns CSV string with header row and data rows
 */
export function rowsToCSV(
  rows: Record<string, unknown>[],
  columns: OutputColumnMetadata[]
): string {
  if (columns.length === 0) {
    return "";
  }

  const columnNames = columns.map((col) => col.name);

  // Header row
  const headerRow = columnNames.map(escapeCSVValue).join(",");

  // Data rows
  const dataRows = rows.map((row) =>
    columnNames.map((name) => escapeCSVValue(row[name])).join(",")
  );

  return [headerRow, ...dataRows].join("\n");
}

/**
 * Convert query result rows to JSON format.
 *
 * @param rows - Array of row objects from query results
 * @returns Formatted JSON string
 */
export function rowsToJSON(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Trigger a file download in the browser.
 *
 * @param content - The file content as a string
 * @param filename - The name for the downloaded file
 * @param mimeType - The MIME type of the file
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
