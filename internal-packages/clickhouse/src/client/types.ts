import type { Result } from "@trigger.dev/core/v3";
import type { z } from "zod";
import type { InsertError, QueryError } from "./errors.js";
import { ClickHouseSettings } from "@clickhouse/client";
import type { BaseQueryParams, InsertResult } from "@clickhouse/client";
import { ClickhouseQueryBuilder, ClickhouseQueryFastBuilder } from "./queryBuilder.js";

export type ClickhouseQueryFunction<TInput, TOutput> = (
  params: TInput,
  options?: {
    attributes?: Record<string, string | number | boolean>;
    params?: BaseQueryParams;
  }
) => Promise<Result<TOutput[], QueryError>>;

/**
 * Query statistics returned by ClickHouse
 */
export interface QueryStats {
  read_rows: string;
  read_bytes: string;
  written_rows: string;
  written_bytes: string;
  total_rows_to_read: string;
  result_rows: string;
  result_bytes: string;
  elapsed_ns: string;
}

/**
 * Result type for queries that include stats
 */
export interface QueryResultWithStats<TOutput> {
  rows: TOutput[];
  stats: QueryStats;
}

export type ClickhouseQueryWithStatsFunction<TInput, TOutput> = (
  params: TInput,
  options?: {
    attributes?: Record<string, string | number | boolean>;
    params?: BaseQueryParams;
  }
) => Promise<Result<QueryResultWithStats<TOutput>, QueryError>>;

export type ClickhouseQueryBuilderFunction<TOutput> = (options?: {
  settings?: ClickHouseSettings;
}) => ClickhouseQueryBuilder<TOutput>;

export type ClickhouseQueryBuilderFastFunction<TOutput extends Record<string, any>> = (options?: {
  settings?: ClickHouseSettings;
}) => ClickhouseQueryFastBuilder<TOutput>;

export type ColumnExpression = {
  name: string;
  expression: string;
};

export interface ClickhouseReader {
  query<TIn extends z.ZodSchema<any>, TOut extends z.ZodSchema<any>>(req: {
    /**
     * The name of the operation.
     * This will be used to identify the operation in the span.
     */
    name: string;
    /**
     * The SQL query to run.
     * Use {paramName: Type} to define parameters
     * Example: `SELECT * FROM table WHERE id = {id: String}`
     */
    query: string;
    /**
     * The schema of the parameters
     * Example: z.object({ id: z.string() })
     */
    params?: TIn;
    /**
     * The schema of the output of each row
     * Example: z.object({ id: z.string() })
     */
    schema: TOut;
    /**
     * The settings to use for the query.
     * These will be merged with the default settings.
     */
    settings?: ClickHouseSettings;
  }): ClickhouseQueryFunction<z.input<TIn>, z.output<TOut>>;

  /**
   * Execute a query and return both rows and query statistics.
   * Same as `query` but includes ClickHouse query stats in the result.
   */
  queryWithStats<TIn extends z.ZodSchema<any>, TOut extends z.ZodSchema<any>>(req: {
    /**
     * The name of the operation.
     * This will be used to identify the operation in the span.
     */
    name: string;
    /**
     * The SQL query to run.
     * Use {paramName: Type} to define parameters
     * Example: `SELECT * FROM table WHERE id = {id: String}`
     */
    query: string;
    /**
     * The schema of the parameters
     * Example: z.object({ id: z.string() })
     */
    params?: TIn;
    /**
     * The schema of the output of each row
     * Example: z.object({ id: z.string() })
     */
    schema: TOut;
    /**
     * The settings to use for the query.
     * These will be merged with the default settings.
     */
    settings?: ClickHouseSettings;
  }): ClickhouseQueryWithStatsFunction<z.input<TIn>, z.output<TOut>>;

  queryFast<TOut extends Record<string, any>, TParams extends Record<string, any>>(req: {
    /**
     * The name of the operation.
     * This will be used to identify the operation in the span.
     */
    name: string;
    /**
     * The SQL query to run.
     * Use {paramName: Type} to define parameters
     * Example: `SELECT * FROM table WHERE id = {id: String}`
     */
    query: string;

    /**
     * The columns returned by the query, in the order
     *
     * @example ["run_id", "created_at", "updated_at"]
     */
    columns: Array<string | ColumnExpression>;
    /**
     * The settings to use for the query.
     * These will be merged with the default settings.
     */
    settings?: ClickHouseSettings;
  }): ClickhouseQueryFunction<TParams, TOut>;

  queryBuilder<TOut extends z.ZodSchema<any>>(req: {
    /**
     * The name of the operation.
     * This will be used to identify the operation in the span.
     */
    name: string;
    /**
     * The initial select clause
     *
     * @example SELECT run_id from trigger_dev.task_runs_v1
     */
    baseQuery: string;
    /**
     * The schema of the output of each row
     * Example: z.object({ id: z.string() })
     */
    schema: TOut;
    /**
     * The settings to use for the query.
     * These will be merged with the default settings.
     */
    settings?: ClickHouseSettings;
  }): ClickhouseQueryBuilderFunction<z.input<TOut>>;

  queryBuilderFast<TOut extends Record<string, any>>(req: {
    /**
     * The name of the operation.
     * This will be used to identify the operation in the span.
     */
    name: string;
    /**
     * The table to query
     *
     * @example trigger_dev.task_runs_v1
     */
    table: string;
    /**
     * The columns to query
     *
     * @example ["run_id", "created_at", "updated_at"]
     */
    columns: Array<string | ColumnExpression>;
    /**
     * The settings to use for the query.
     * These will be merged with the default settings.
     */
    settings?: ClickHouseSettings;
  }): ClickhouseQueryBuilderFastFunction<TOut>;

  close(): Promise<void>;
}

export type ClickhouseInsertFunction<TInput> = (
  events: TInput | TInput[],
  options?: {
    attributes?: Record<string, string | number | boolean>;
    params?: BaseQueryParams;
  }
) => Promise<Result<InsertResult, InsertError>>;

export interface ClickhouseWriter {
  insert<TSchema extends z.ZodSchema<any>>(req: {
    name: string;
    table: string;
    schema: TSchema;
    settings?: ClickHouseSettings;
  }): ClickhouseInsertFunction<z.input<TSchema>>;

  insertUnsafe<TRecord extends Record<string, any>>(req: {
    name: string;
    table: string;
    settings?: ClickHouseSettings;
  }): ClickhouseInsertFunction<TRecord>;

  close(): Promise<void>;
}
