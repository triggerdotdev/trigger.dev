import type {
  ApiRequestOptions,
  Prettify,
  QueryExecuteResponseBody,
  QueryExecuteCSVResponseBody,
} from "@trigger.dev/core/v3";
import { apiClientManager, mergeRequestOptions } from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export type { QueryTable, RunsTableRow, RunFriendlyStatus } from "@trigger.dev/core/v3";

export type QueryScope = "environment" | "project" | "organization";
export type QueryFormat = "json" | "csv";

/**
 * Options for executing a TRQL query
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
  scope?: QueryScope;

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
 * Execute a TRQL query and get the results as a CSV string.
 *
 * @param {string} query - The TRQL query string to execute
 * @param {QueryOptions & { format: "csv" }} options - Query options with `format: "csv"`
 * @param {ApiRequestOptions} [requestOptions] - Optional API request configuration
 * @returns A promise resolving to `{ format: "csv", results: string }` where `results` is the raw CSV text
 *
 * @example
 * ```typescript
 * const csvResult = await query.execute(
 *   "SELECT run_id, status, triggered_at FROM runs",
 *   { format: "csv", period: "7d" }
 * );
 * const lines = csvResult.results.split('\n');
 * ```
 */
function execute(
  query: string,
  options: QueryOptions & { format: "csv" },
  requestOptions?: ApiRequestOptions
): Promise<{ format: "csv"; results: string }>;

/**
 * Execute a TRQL query and return typed JSON rows.
 *
 * @template TRow - The shape of each row in the result set. Use {@link QueryTable} for type-safe column access (e.g. `QueryTable<"runs", "status" | "run_id">`)
 * @param {string} query - The TRQL query string to execute
 * @param {QueryOptions} [options] - Optional query configuration
 * @param {ApiRequestOptions} [requestOptions] - Optional API request configuration
 * @returns A promise resolving to `{ format: "json", results: Array<TRow> }`
 *
 * @example
 * ```typescript
 * // Basic query with defaults (environment scope, json format)
 * const result = await query.execute("SELECT run_id, status FROM runs LIMIT 10");
 * console.log(result.results); // Array<Record<string, any>>
 *
 * // Type-safe query using QueryTable with specific columns
 * const typedResult = await query.execute<QueryTable<"runs", "run_id" | "status" | "triggered_at">>(
 *   "SELECT run_id, status, triggered_at FROM runs LIMIT 10"
 * );
 * typedResult.results.forEach(row => {
 *   console.log(row.run_id, row.status); // Fully typed!
 * });
 *
 * // Inline type for aggregation queries
 * const stats = await query.execute<{ status: string; count: number }>(
 *   "SELECT status, COUNT(*) as count FROM runs GROUP BY status"
 * );
 * stats.results.forEach(row => {
 *   console.log(row.status, row.count); // Fully type-safe
 * });
 *
 * // Query with a custom time period
 * const recent = await query.execute(
 *   "SELECT COUNT(*) as count FROM runs",
 *   { period: "3d" }
 * );
 * console.log(recent.results[0].count);
 * ```
 */
function execute<TRow extends Record<string, any> = Record<string, any>>(
  query: string,
  options?: Omit<QueryOptions, "format"> | (QueryOptions & { format?: "json" }),
  requestOptions?: ApiRequestOptions
): Promise<{ format: "json"; results: Array<Prettify<TRow>> }>;

// Implementation
function execute<TRow extends Record<string, any> = Record<string, any>>(
  query: string,
  options?: QueryOptions,
  requestOptions?: ApiRequestOptions
): Promise<{ format: "json"; results: Array<TRow> } | { format: "csv"; results: string }> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "query.execute()",
      icon: "query",
      attributes: {
        scope: options?.scope ?? "environment",
        format: options?.format ?? "json",
        query,
        period: options?.period,
        from: options?.from,
        to: options?.to,
      },
    },
    requestOptions
  );

  return apiClient.executeQuery(query, options, $requestOptions).then((response) => {
    return response;
  }) as Promise<{ format: "json"; results: Array<TRow> } | { format: "csv"; results: string }>;
}

export const query = {
  execute,
};
