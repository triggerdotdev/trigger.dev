/**
 * TSQL Query Execution for ClickHouse
 *
 * This module provides a safe interface for executing TSQL queries against ClickHouse
 * with enforced WHERE clause conditions (tenant isolation + plan limits) and SQL injection protection.
 */

import type { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import {
  compileTSQL,
  sanitizeErrorMessage,
  transformResults,
  type TableSchema,
  type QuerySettings,
  type FieldMappings,
  type WhereClauseCondition
} from "@internal/tsql";
import type { ClickhouseReader, QueryStats } from "./types.js";
import { QueryError } from "./errors.js";
import type { OutputColumnMetadata } from "@internal/tsql";
import { Logger } from "@trigger.dev/core/logger";

const logger = new Logger("tsql", "info");

export type { QueryStats };

export type { TableSchema, QuerySettings, FieldMappings, WhereClauseCondition };

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
  /** Schema registry defining allowed tables and columns */
  tableSchema: TableSchema[];
  /**
   * REQUIRED: Conditions always applied at the table level.
   * Must include tenant columns (e.g., organization_id) for multi-tenant tables.
   * Applied to every table reference including subqueries, CTEs, and JOINs.
   *
   * @example
   * ```typescript
   * {
   *   // Tenant isolation
   *   organization_id: { op: "eq", value: "org_123" },
   *   project_id: { op: "eq", value: "proj_456" },
   *   environment_id: { op: "eq", value: "env_789" },
   *   // Plan-based time limit
   *   triggered_at: { op: "gte", value: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
   * }
   * ```
   */
  enforcedWhereClause: Record<string, WhereClauseCondition | undefined>;
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
  /**
   * Run EXPLAIN instead of executing the query.
   * Returns the ClickHouse execution plan with index information.
   * Should only be used by admins for debugging query performance.
   * @default false
   */
  explain?: boolean;
  /**
   * Fallback WHERE conditions to apply when the user hasn't filtered on a column.
   * Key is the column name, value is the fallback condition.
   * These are applied at the AST level (top-level query only).
   *
   * @example
   * ```typescript
   * // Apply triggered_at >= 7 days ago if user doesn't filter on triggered_at
   * whereClauseFallback: {
   *   triggered_at: { op: 'gte', value: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
   * }
   * ```
   */
  whereClauseFallback?: Record<string, WhereClauseCondition>;
}

/**
 * Successful result from TSQL query execution
 */
export interface TSQLQuerySuccess<T> {
  rows: T[];
  columns: OutputColumnMetadata[];
  stats: QueryStats;
  /**
   * Columns that were hidden when SELECT * was used.
   * Only populated when SELECT * is transformed to core columns only.
   */
  hiddenColumns?: string[];
  /**
   * Whether the result count equals the maxRows limit.
   * When true, the results may be truncated and more rows may exist.
   */
  reachedMaxRows: boolean;
  /**
   * The raw EXPLAIN output from ClickHouse.
   * Only populated when `explain: true` is passed.
   */
  explainOutput?: string;
  /**
   * The generated ClickHouse SQL query.
   * Only populated when `explain: true` is passed.
   */
  generatedSql?: string;
}

/**
 * Result type for TSQL query execution
 */
export type TSQLQueryResult<T> = [QueryError, null] | [null, TSQLQuerySuccess<T>];

/**
 * Execute a TSQL query against ClickHouse
 *
 * This function:
 * 1. Compiles the TSQL query to ClickHouse SQL (parse, validate, inject enforced WHERE clauses)
 * 2. Executes the query and returns validated results
 *
 * @example
 * ```typescript
 * const [error, rows] = await executeTSQL(reader, {
 *   name: "get_task_runs",
 *   query: "SELECT id, status FROM task_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 100",
 *   schema: z.object({ id: z.string(), status: z.string() }),
 *   tableSchema: [taskRunsSchema],
 *   enforcedWhereClause: {
 *     organization_id: { op: "eq", value: "org_123" },
 *     project_id: { op: "eq", value: "proj_456" },
 *     environment_id: { op: "eq", value: "env_789" },
 *   },
 * });
 * ```
 */
export async function executeTSQL<TOut extends z.ZodSchema>(
  reader: ClickhouseReader,
  options: ExecuteTSQLOptions<TOut>
): Promise<TSQLQueryResult<z.output<TOut>>> {
  const shouldTransformValues = options.transformValues ?? true;
  const isExplain = options.explain ?? false;
  const maxRows = options.querySettings?.maxRows;

  let generatedSql: string | undefined;
  let generatedParams: Record<string, unknown> | undefined;

  try {
    // 1. Compile the TSQL query to ClickHouse SQL
    // Pass maxRows + 1 to fetch one extra row for overflow detection
    const compiledSettings = maxRows !== undefined
      ? { ...options.querySettings, maxRows: maxRows + 1 }
      : options.querySettings;

    const { sql, params, columns, hiddenColumns } = compileTSQL(options.query, {
      tableSchema: options.tableSchema,
      enforcedWhereClause: options.enforcedWhereClause,
      settings: compiledSettings,
      fieldMappings: options.fieldMappings,
      whereClauseFallback: options.whereClauseFallback,
    });

    generatedSql = sql;
    generatedParams = params;

    // 2. Execute the query (or EXPLAIN) with stats
    const queryToExecute = isExplain ? `EXPLAIN indexes = 1 ${sql}` : sql;

    const queryFn = reader.queryWithStats({
      name: isExplain ? `${options.name}-explain` : options.name,
      query: queryToExecute,
      params: z.record(z.any()),
      // EXPLAIN returns rows with an 'explain' column
      schema: isExplain ? z.object({ explain: z.string() }) : options.schema,
      settings: options.clickhouseSettings,
    });

    const [error, result] = await queryFn(params);

    if (error) {
      // Sanitize error message to show TSQL names instead of ClickHouse internals
      const sanitizedMessage = sanitizeErrorMessage(error.message, options.tableSchema);
      return [new QueryError(sanitizedMessage, { query: options.query }), null];
    }

    const { rows, stats } = result;

    // Handle EXPLAIN mode - run multiple explain types and combine outputs
    if (isExplain) {
      const explainRows = rows as Array<{ explain: string }>;
      const indexesOutput = explainRows.map((r) => r.explain).join("\n");

      // Run additional explain queries for more comprehensive output
      const explainTypes = [
        { name: "ESTIMATE", query: `EXPLAIN ESTIMATE ${sql}` },
        { name: "PIPELINE", query: `EXPLAIN PIPELINE ${sql}` },
      ];

      const additionalOutputs: string[] = [];

      for (const explainType of explainTypes) {
        try {
          const additionalQueryFn = reader.queryWithStats({
            name: `${options.name}-explain-${explainType.name.toLowerCase()}`,
            query: explainType.query,
            params: z.record(z.any()),
            schema: z.object({ explain: z.string() }),
            settings: options.clickhouseSettings,
          });

          const [additionalError, additionalResult] = await additionalQueryFn(params);

          if (!additionalError && additionalResult) {
            const additionalRows = additionalResult.rows as Array<{ explain: string }>;
            const output = additionalRows.map((r) => r.explain).join("\n");
            additionalOutputs.push(`── ${explainType.name} ──\n${output}`);
          }
        } catch {
          // Ignore errors from additional explain queries
        }
      }

      // Combine all explain outputs
      const combinedOutput = ["── INDEXES ──", indexesOutput, "", ...additionalOutputs].join("\n");

      return [
        null,
        {
          rows: [] as z.output<TOut>[],
          columns: [],
          stats,
          hiddenColumns,
          reachedMaxRows: false,
          explainOutput: combinedOutput,
          generatedSql,
        },
      ];
    }

    // Determine if we exceeded maxRows (we fetched maxRows + 1 to detect overflow)
    const reachedMaxRows = maxRows !== undefined && rows !== undefined && rows.length > maxRows;

    // Remove the overflow row if we got one (pop is O(1), slice would be O(n))
    const finalRows = rows ?? [];
    if (reachedMaxRows) {
      finalRows.pop();
    }

    // Build the result, including hiddenColumns if present
    const baseResult = { columns, stats, hiddenColumns, reachedMaxRows };

    // 3. Transform result values if enabled
    if (shouldTransformValues && finalRows.length > 0) {
      const transformedRows = transformResults(
        finalRows as Record<string, unknown>[],
        options.tableSchema,
        { fieldMappings: options.fieldMappings }
      );
      return [null, { rows: transformedRows as z.output<TOut>[], ...baseResult }];
    }

    return [null, { rows: finalRows as z.output<TOut>[], ...baseResult }];
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Log TSQL compilation or unexpected errors (with original message for debugging)
    logger.error("[TSQL] Query error", {
      name: options.name,
      error: errorMessage,
      tsql: options.query,
      generatedSql: generatedSql ?? "(compilation failed)",
      generatedParams: generatedParams ?? {},
    });

    // Sanitize error message to show TSQL names instead of ClickHouse internals
    const sanitizedMessage = sanitizeErrorMessage(errorMessage, options.tableSchema);

    if (error instanceof Error) {
      return [new QueryError(sanitizedMessage, { query: options.query }), null];
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
 *   enforcedWhereClause: {
 *     organization_id: { op: "eq", value: "org_123" },
 *     project_id: { op: "eq", value: "proj_456" },
 *     environment_id: { op: "eq", value: "env_789" },
 *   },
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
