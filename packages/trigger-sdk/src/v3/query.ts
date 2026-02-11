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
export type QueryOptions<TFormat extends QueryFormat | undefined = QueryFormat | undefined> = {
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
  format?: TFormat;
};

/**
 * Result type that automatically narrows based on the format option
 * @template TFormat - The format type (json or csv)
 * @template TRow - The shape of each row in the result set
 */
export type QueryResult<
  TFormat extends QueryFormat | undefined = undefined,
  TRow extends Record<string, any> = Record<string, any>
> = TFormat extends "csv"
  ? QueryExecuteCSVResponseBody
  : TFormat extends "json"
  ? { rows: Array<TRow> }
  : TFormat extends undefined
  ? { rows: Array<TRow> }
  : { rows: Array<TRow> } | QueryExecuteCSVResponseBody;

/**
 * Execute a TSQL query against your Trigger.dev data
 *
 * @template TFormat - The format of the response (inferred from options)
 * @param {string} tsql - The TSQL query string to execute
 * @param {QueryOptions<TFormat>} [options] - Optional query configuration
 * @param {ApiRequestOptions} [requestOptions] - Optional API request configuration
 * @returns A promise that resolves with the query results
 *
 * @example
 * ```typescript
 * // Basic query with defaults (environment scope, json format)
 * const result = await query.execute("SELECT * FROM runs LIMIT 10");
 * console.log(result.rows);
 *
 * // Query with custom period
 * const lastMonth = await query.execute(
 *   "SELECT COUNT(*) as count FROM runs",
 *   { period: "30d" }
 * );
 *
 * // Query with custom date range
 * const januaryRuns = await query.execute(
 *   "SELECT * FROM runs",
 *   {
 *     from: "2025-01-01T00:00:00Z",
 *     to: "2025-02-01T00:00:00Z"
 *   }
 * );
 *
 * // Organization-wide query
 * const orgStats = await query.execute(
 *   "SELECT project, COUNT(*) as count FROM runs GROUP BY project",
 *   { scope: "organization", period: "7d" }
 * );
 *
 * // Export as CSV
 * const csvData = await query.execute(
 *   "SELECT * FROM runs",
 *   { format: "csv", period: "7d" }
 * );
 * // csvData is a string containing CSV
 * ```
 */
function execute<TFormat extends QueryFormat | undefined = undefined>(
  tsql: string,
  options?: QueryOptions<TFormat>,
  requestOptions?: ApiRequestOptions
): Promise<QueryResult<TFormat>> {
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

  return apiClient.executeQuery(tsql, options, $requestOptions) as Promise<QueryResult<TFormat>>;
}

export const query = {
  execute,
};
