import type {
  ApiRequestOptions,
  QueryExecuteResponseBody,
  QueryExecuteCSVResponseBody,
} from "@trigger.dev/core/v3";
import { apiClientManager, mergeRequestOptions } from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export type QueryScope = "environment" | "project" | "organization";
export type QueryFormat = "json" | "csv";

/**
 * Options for executing a TSQL query
 */
export type QueryOptions = {
  /**
   * The scope of the query - determines what data is accessible
   * - "environment": Current environment only (default)
   * - "project": All environments in the project
   * - "organization": All projects in the organization
   *
   * @default "environment"
   */
  scope?: "environment" | "project" | "organization";

  /**
   * Time period to query (e.g., "7d", "30d", "1h")
   * Cannot be used with `from` or `to`
   */
  period?: string;

  /**
   * Start of time range (ISO 8601 timestamp)
   * Must be used with `to`
   */
  from?: string;

  /**
   * End of time range (ISO 8601 timestamp)
   * Must be used with `from`
   */
  to?: string;

  /**
   * Response format
   * - "json": Returns structured data (default)
   * - "csv": Returns CSV string
   *
   * @default "json"
   */
  format?: QueryFormat;
};

/**
 * Execute a TSQL query and export as CSV
 */
function execute(
  tsql: string,
  options: QueryOptions & { format: "csv" },
  requestOptions?: ApiRequestOptions
): Promise<{ format: "csv"; results: string }>;

/**
 * Execute a TSQL query and return typed JSON rows
 */
function execute<TRow extends Record<string, any> = Record<string, any>>(
  tsql: string,
  options?: Omit<QueryOptions, "format"> | (QueryOptions & { format?: "json" }),
  requestOptions?: ApiRequestOptions
): Promise<{ format: "json"; results: Array<TRow> }>;

/**
 * Execute a TSQL query against your Trigger.dev data
 *
 * @template TRow - The shape of each row in the result set (provide for type safety)
 * @param {string} tsql - The TSQL query string to execute
 * @param {QueryOptions} [options] - Optional query configuration
 * @param {ApiRequestOptions} [requestOptions] - Optional API request configuration
 * @returns A promise that resolves with the query results
 *
 * @example
 * ```typescript
 * // Basic query with defaults (environment scope, json format)
 * const result = await query.execute("SELECT * FROM runs LIMIT 10");
 * console.log(result.format); // "json"
 * console.log(result.results); // Array<Record<string, any>>
 *
 * // Type-safe query with row type
 * type RunRow = { id: string; status: string; duration: number };
 * const typedResult = await query.execute<RunRow>(
 *   "SELECT id, status, duration FROM runs LIMIT 10"
 * );
 * typedResult.results.forEach(row => {
 *   console.log(row.id, row.status); // Fully typed!
 * });
 *
 * // Inline type for aggregation query
 * const stats = await query.execute<{ status: string; count: number }>(
 *   "SELECT status, COUNT(*) as count FROM runs GROUP BY status"
 * );
 * stats.results.forEach(row => {
 *   console.log(row.status, row.count); // Fully type-safe
 * });
 *
 * // Query with custom period
 * const lastMonth = await query.execute(
 *   "SELECT COUNT(*) as count FROM runs",
 *   { period: "30d" }
 * );
 * console.log(lastMonth.results[0].count); // Type-safe access
 *
 * // Export as CSV - automatically narrowed!
 * const csvResult = await query.execute(
 *   "SELECT * FROM runs",
 *   { format: "csv", period: "7d" }
 * );
 * console.log(csvResult.format); // "csv"
 * const lines = csvResult.results.split('\n'); // ✓ results is string
 *
 * // Discriminated union - can check format at runtime
 * const dynamicResult = await query.execute("SELECT * FROM runs");
 * if (dynamicResult.format === "json") {
 *   dynamicResult.results.forEach(row => console.log(row)); // ✓ Typed as array
 * } else {
 *   console.log(dynamicResult.results.length); // ✓ Typed as string
 * }
 * ```
 */
function execute<TRow extends Record<string, any> = Record<string, any>>(
  tsql: string,
  options?: QueryOptions,
  requestOptions?: ApiRequestOptions
): Promise<{ format: "json"; results: Array<TRow> } | { format: "csv"; results: string }> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "query.execute()",
      icon: "sparkles",
      attributes: {
        scope: options?.scope ?? "environment",
        format: options?.format ?? "json",
      },
    },
    requestOptions
  );

  const format = options?.format ?? "json";

  return apiClient.executeQuery(tsql, options, $requestOptions).then((response) => {
    if (typeof response === "string") {
      return { format: "csv" as const, results: response };
    }
    return { format: "json" as const, results: response.rows };
  }) as Promise<{ format: "json"; results: Array<TRow> } | { format: "csv"; results: string }>;
}

export const query = {
  execute,
};
