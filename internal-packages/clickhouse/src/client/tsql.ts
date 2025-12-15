/**
 * TSQL Query Execution for ClickHouse
 *
 * This module provides a safe interface for executing TSQL queries against ClickHouse
 * with automatic tenant isolation and SQL injection protection.
 */

import type { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import type { ClickhouseReader } from "./types.js";
import { QueryError } from "./errors.js";

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
  tableSchema: TSQLTableSchema[];
  /** Optional ClickHouse query settings */
  settings?: ClickHouseSettings;
  /** Maximum number of rows to return (default: 10000) */
  maxRows?: number;
  /** Timezone for date/time operations (default: UTC) */
  timezone?: string;
}

/**
 * Schema definition for a table accessible via TSQL
 */
export interface TSQLTableSchema {
  /** The name of the table as used in TSQL queries */
  name: string;
  /** The fully qualified ClickHouse table name */
  clickhouseName: string;
  /** Column definitions */
  columns: Record<string, TSQLColumnSchema>;
  /** Tenant isolation column configuration */
  tenantColumns: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
}

/**
 * Schema definition for a column
 */
export interface TSQLColumnSchema {
  /** The column name */
  name: string;
  /** The ClickHouse column name (if different from name) */
  clickhouseName?: string;
  /** Whether the column can be selected */
  selectable?: boolean;
  /** Whether the column can be used in WHERE */
  filterable?: boolean;
  /** Whether the column can be used in ORDER BY */
  sortable?: boolean;
  /** Whether the column can be used in GROUP BY */
  groupable?: boolean;
}

/**
 * Result type for TSQL query execution
 */
export type TSQLQueryResult<T> = [QueryError, null] | [null, T[]];

/**
 * Execute a TSQL query against ClickHouse
 *
 * This function:
 * 1. Parses the TSQL query into an AST
 * 2. Validates tables and columns against the schema
 * 3. Injects tenant isolation WHERE clauses
 * 4. Generates parameterized ClickHouse SQL
 * 5. Executes the query and returns validated results
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
  // Lazy import to avoid circular dependencies and keep the TSQL package optional
  const {
    parseTSQLSelect,
    createPrinterContext,
    createSchemaRegistry,
    printToClickHouse,
  } = await import("@internal/tsql");

  try {
    // 1. Parse the TSQL query
    const ast = parseTSQLSelect(options.query);

    // 2. Create schema registry from table schemas
    const schemaRegistry = createSchemaRegistry(options.tableSchema);

    // 3. Create printer context with tenant IDs
    const context = createPrinterContext({
      organizationId: options.organizationId,
      projectId: options.projectId,
      environmentId: options.environmentId,
      schema: schemaRegistry,
      settings: {
        maxRows: options.maxRows ?? 10000,
        timezone: options.timezone ?? "UTC",
      },
    });

    // 4. Print the AST to ClickHouse SQL
    const { sql, params } = printToClickHouse(ast, context);

    // 5. Execute the query
    const queryFn = reader.query({
      name: options.name,
      query: sql,
      params: z.record(z.any()),
      schema: options.schema,
      settings: options.settings,
    });

    return await queryFn(params);
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
export function createTSQLExecutor(reader: ClickhouseReader, tableSchema: TSQLTableSchema[]) {
  return {
    execute: <TOut extends z.ZodSchema>(
      options: Omit<ExecuteTSQLOptions<TOut>, "tableSchema">
    ): Promise<TSQLQueryResult<z.output<TOut>>> => {
      return executeTSQL(reader, { ...options, tableSchema });
    },
  };
}

