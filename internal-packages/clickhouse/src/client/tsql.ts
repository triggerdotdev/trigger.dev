/**
 * TSQL Query Execution for ClickHouse
 *
 * This module provides a safe interface for executing TSQL queries against ClickHouse
 * with automatic tenant isolation and SQL injection protection.
 */

import type { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import {
  compileTSQL,
  transformResults,
  type TableSchema,
  type QuerySettings,
} from "@internal/tsql";
import type { ClickhouseReader } from "./types.js";
import { QueryError } from "./errors.js";

// Re-export TableSchema for convenience
export type { TableSchema, QuerySettings };

/**
 * Options for executing a TSQL query
 */
export interface ExecuteTSQLOptions<TOut extends z.ZodSchema> {
  /** The name of the operation (for logging/tracing) */
  name: string;
  /** The TSQL query string to execute */
  query: string;
  /** The Zod schema for validating output rows */
  schema: TOut;
  /** The organization ID for tenant isolation */
  organizationId: string;
  /** The project ID for tenant isolation */
  projectId: string;
  /** The environment ID for tenant isolation */
  environmentId: string;
  /** Schema registry defining allowed tables and columns */
  tableSchema: TableSchema[];
  /** Optional ClickHouse query settings */
  clickhouseSettings?: ClickHouseSettings;
  /** Optional TSQL query settings (maxRows, timezone, etc.) */
  querySettings?: Partial<QuerySettings>;
  /**
   * Whether to transform result values using the schema's valueMap
   * When enabled, internal ClickHouse values (e.g., 'COMPLETED_SUCCESSFULLY')
   * are converted to user-friendly display names (e.g., 'Completed')
   * @default true
   */
  transformValues?: boolean;
}

/**
 * Result type for TSQL query execution
 */
export type TSQLQueryResult<T> = [QueryError, null] | [null, T[]];

/**
 * Execute a TSQL query against ClickHouse
 *
 * This function:
 * 1. Compiles the TSQL query to ClickHouse SQL (parse, validate, inject tenant guards)
 * 2. Executes the query and returns validated results
 *
 * @example
 * ```typescript
 * const [error, rows] = await executeTSQL(reader, {
 *   name: "get_task_runs",
 *   query: "SELECT id, status FROM task_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 100",
 *   schema: z.object({ id: z.string(), status: z.string() }),
 *   organizationId: "org_123",
 *   projectId: "proj_456",
 *   environmentId: "env_789",
 *   tableSchema: [taskRunsSchema],
 * });
 * ```
 */
export async function executeTSQL<TOut extends z.ZodSchema>(
  reader: ClickhouseReader,
  options: ExecuteTSQLOptions<TOut>
): Promise<TSQLQueryResult<z.output<TOut>>> {
  const shouldTransformValues = options.transformValues ?? true;

  try {
    // 1. Compile the TSQL query to ClickHouse SQL
    const { sql, params } = compileTSQL(options.query, {
      organizationId: options.organizationId,
      projectId: options.projectId,
      environmentId: options.environmentId,
      tableSchema: options.tableSchema,
      settings: options.querySettings,
    });

    // 2. Execute the query
    const queryFn = reader.query({
      name: options.name,
      query: sql,
      params: z.record(z.any()),
      schema: options.schema,
      settings: options.clickhouseSettings,
    });

    const [error, rows] = await queryFn(params);

    if (error) {
      return [error, null];
    }

    // 3. Transform result values if enabled
    if (shouldTransformValues && rows) {
      const transformedRows = transformResults(
        rows as Record<string, unknown>[],
        options.tableSchema
      );
      return [null, transformedRows as z.output<TOut>[]];
    }

    return [null, rows];
  } catch (error) {
    if (error instanceof Error) {
      return [new QueryError(error.message, { query: options.query }), null];
    }
    return [new QueryError("Unknown error executing TSQL query", { query: options.query }), null];
  }
}

/**
 * Create a reusable TSQL query executor bound to specific table schemas
 *
 * @example
 * ```typescript
 * const tsqlExecutor = createTSQLExecutor(reader, [taskRunsSchema, taskEventsSchema]);
 *
 * const [error, rows] = await tsqlExecutor.execute({
 *   name: "get_task_runs",
 *   query: "SELECT * FROM task_runs LIMIT 10",
 *   schema: taskRunRowSchema,
 *   organizationId: "org_123",
 *   projectId: "proj_456",
 *   environmentId: "env_789",
 * });
 * ```
 */
export function createTSQLExecutor(reader: ClickhouseReader, tableSchema: TableSchema[]) {
  return {
    execute: <TOut extends z.ZodSchema>(
      options: Omit<ExecuteTSQLOptions<TOut>, "tableSchema">
    ): Promise<TSQLQueryResult<z.output<TOut>>> => {
      return executeTSQL(reader, { ...options, tableSchema });
    },
  };
}
