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
  type FieldMappings,
} from "@internal/tsql";
import type { ClickhouseReader, QueryStats } from "./types.js";
import { QueryError } from "./errors.js";
import type { OutputColumnMetadata } from "@internal/tsql";

export type { QueryStats };

export type { TableSchema, QuerySettings, FieldMappings };

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
  /** The organization ID for tenant isolation (required) */
  organizationId: string;
  /** The project ID for tenant isolation (optional - omit to query across all projects) */
  projectId?: string;
  /** The environment ID for tenant isolation (optional - omit to query across all environments) */
  environmentId?: string;
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
  /**
   * Runtime field mappings for dynamic value translation.
   * Maps internal ClickHouse values to external user-facing values.
   *
   * @example
   * ```typescript
   * {
   *   project: { "cm12345": "my-project-ref" },
   * }
   * ```
   */
  fieldMappings?: FieldMappings;
}

/**
 * Successful result from TSQL query execution
 */
export interface TSQLQuerySuccess<T> {
  rows: T[];
  columns: OutputColumnMetadata[];
  stats: QueryStats;
}

/**
 * Result type for TSQL query execution
 */
export type TSQLQueryResult<T> = [QueryError, null] | [null, TSQLQuerySuccess<T>];

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
    const { sql, params, columns } = compileTSQL(options.query, {
      organizationId: options.organizationId,
      projectId: options.projectId,
      environmentId: options.environmentId,
      tableSchema: options.tableSchema,
      settings: options.querySettings,
      fieldMappings: options.fieldMappings,
    });

    // 2. Execute the query with stats
    const queryFn = reader.queryWithStats({
      name: options.name,
      query: sql,
      params: z.record(z.any()),
      schema: options.schema,
      settings: options.clickhouseSettings,
    });

    const [error, result] = await queryFn(params);

    if (error) {
      return [error, null];
    }

    const { rows, stats } = result;

    // 3. Transform result values if enabled
    if (shouldTransformValues && rows) {
      const transformedRows = transformResults(
        rows as Record<string, unknown>[],
        options.tableSchema,
        { fieldMappings: options.fieldMappings }
      );
      return [null, { rows: transformedRows as z.output<TOut>[], columns, stats }];
    }

    return [null, { rows: rows ?? [], columns, stats }];
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
