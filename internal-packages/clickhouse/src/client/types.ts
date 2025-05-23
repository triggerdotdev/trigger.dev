import type { Result } from "@trigger.dev/core/v3";
import type { z } from "zod";
import type { InsertError, QueryError } from "./errors.js";
import { ClickHouseSettings } from "@clickhouse/client";
import type { BaseQueryParams, InsertResult } from "@clickhouse/client";
import { ClickhouseQueryBuilder } from "./queryBuilder.js";

export type ClickhouseQueryFunction<TInput, TOutput> = (
  params: TInput,
  options?: {
    attributes?: Record<string, string | number | boolean>;
    params?: BaseQueryParams;
  }
) => Promise<Result<TOutput[], QueryError>>;

export type ClickhouseQueryBuilderFunction<TOutput> = (options?: {
  settings?: ClickHouseSettings;
}) => ClickhouseQueryBuilder<TOutput>;

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

  close(): Promise<void>;
}
