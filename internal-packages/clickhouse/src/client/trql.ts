/**
 * TRQL Query Execution for ClickHouse
 *
 * This module provides a safe interface for executing TRQL queries against ClickHouse
 * with automatic tenant isolation and SQL injection protection.
 */

import type { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import {
  compileTRQL,
  transformResults,
  type TableSchema,
  type QuerySettings,
  type FieldMappings,
} from "@internal/trql";
import type { ClickhouseReader, QueryStats } from "./types.js";
import { QueryError } from "./errors.js";
import type { OutputColumnMetadata } from "@internal/trql";

export type { QueryStats };

export type { TableSchema, QuerySettings, FieldMappings };

/**
 * Options for executing a TRQL query
 */
export interface ExecuteTRQLOptions<TOut extends z.ZodSchema> {
  /** The name of the operation (for logging/tracing) */
  name: string;
  /** The TRQL query string to execute */
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
  /** Optional TRQL query settings (maxRows, timezone, etc.) */
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
 * Successful result from TRQL query execution
 */
export interface TRQLQuerySuccess<T> {
  rows: T[];
  columns: OutputColumnMetadata[];
  stats: QueryStats;
}

/**
 * Result type for TRQL query execution
 */
export type TRQLQueryResult<T> = [QueryError, null] | [null, TRQLQuerySuccess<T>];

/**
 * Execute a TRQL query against ClickHouse
 *
 * This function:
 * 1. Compiles the TRQL query to ClickHouse SQL (parse, validate, inject tenant guards)
 * 2. Executes the query and returns validated results
 *
 * @example
 * ```typescript
 * const [error, rows] = await executeTRQL(reader, {
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
export async function executeTRQL<TOut extends z.ZodSchema>(
  reader: ClickhouseReader,
  options: ExecuteTRQLOptions<TOut>
): Promise<TRQLQueryResult<z.output<TOut>>> {
  const shouldTransformValues = options.transformValues ?? true;

  try {
    // 1. Compile the TRQL query to ClickHouse SQL
    const { sql, params, columns } = compileTRQL(options.query, {
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
    return [new QueryError("Unknown error executing TRQL query", { query: options.query }), null];
  }
}

/**
 * Create a reusable TRQL query executor bound to specific table schemas
 *
 * @example
 * ```typescript
 * const trqlExecutor = createTRQLExecutor(reader, [taskRunsSchema, taskEventsSchema]);
 *
 * const [error, rows] = await trqlExecutor.execute({
 *   name: "get_task_runs",
 *   query: "SELECT * FROM task_runs LIMIT 10",
 *   schema: taskRunRowSchema,
 *   organizationId: "org_123",
 *   projectId: "proj_456",
 *   environmentId: "env_789",
 * });
 * ```
 */
export function createTRQLExecutor(reader: ClickhouseReader, tableSchema: TableSchema[]) {
  return {
    execute: <TOut extends z.ZodSchema>(
      options: Omit<ExecuteTRQLOptions<TOut>, "tableSchema">
    ): Promise<TRQLQueryResult<z.output<TOut>>> => {
      return executeTRQL(reader, { ...options, tableSchema });
    },
  };
}
