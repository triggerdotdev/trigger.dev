import { Result } from "@trigger.dev/core/v3";
import { InsertError, QueryError } from "./errors.js";
import {
  ClickhouseQueryBuilderFastFunction,
  ClickhouseQueryBuilderFunction,
  ClickhouseWriter,
} from "./types.js";
import { ClickhouseReader } from "./types.js";
import { z } from "zod";
import { ClickHouseSettings, InsertResult } from "@clickhouse/client";
import { ClickhouseQueryBuilder, ClickhouseQueryFastBuilder } from "./queryBuilder.js";

export class NoopClient implements ClickhouseReader, ClickhouseWriter {
  public async close() {
    return;
  }

  public queryBuilder<TOut extends z.ZodSchema<any>>(req: {
    name: string;
    baseQuery: string;
    schema: TOut;
    settings?: ClickHouseSettings;
  }): ClickhouseQueryBuilderFunction<z.input<TOut>> {
    return () =>
      new ClickhouseQueryBuilder(req.name, req.baseQuery, this, req.schema, req.settings);
  }

  public queryBuilderFast<TOut extends Record<string, any>>(req: {
    name: string;
    table: string;
    columns: string[];
    settings?: ClickHouseSettings;
  }): ClickhouseQueryBuilderFastFunction<TOut> {
    return () =>
      new ClickhouseQueryFastBuilder(req.name, req.table, req.columns, this, req.settings);
  }

  public query<TIn extends z.ZodSchema<any>, TOut extends z.ZodSchema<any>>(req: {
    query: string;
    params?: TIn;
    schema: TOut;
  }): (params: z.input<TIn>) => Promise<Result<z.output<TOut>[], QueryError>> {
    return async (params: z.input<TIn>) => {
      const validParams = req.params?.safeParse(params);

      if (validParams?.error) {
        return [new QueryError(`Bad params: ${validParams.error.message}`, { query: "" }), null];
      }

      return [null, []];
    };
  }

  public queryFast<TOut extends Record<string, any>, TParams extends Record<string, any>>(req: {
    name: string;
    query: string;
    columns: string[];
    settings?: ClickHouseSettings;
  }): (params: TParams) => Promise<Result<TOut[], QueryError>> {
    return async (params: TParams) => {
      return [null, []];
    };
  }

  public insert<TSchema extends z.ZodSchema<any>>(req: {
    name: string;
    table: string;
    schema: TSchema;
    settings?: ClickHouseSettings;
  }): (
    events: z.input<TSchema> | z.input<TSchema>[]
  ) => Promise<Result<InsertResult, InsertError>> {
    return async (events: z.input<TSchema> | z.input<TSchema>[]) => {
      const v = Array.isArray(events)
        ? req.schema.array().safeParse(events)
        : req.schema.safeParse(events);

      if (!v.success) {
        return [new InsertError(v.error.message), null];
      }

      return [
        null,
        {
          executed: true,
          query_id: "noop",
          summary: {
            read_rows: "0",
            read_bytes: "0",
            written_rows: "0",
            written_bytes: "0",
            total_rows_to_read: "0",
            result_rows: "0",
            result_bytes: "0",
            elapsed_ns: "0",
          },
          response_headers: {},
        },
      ];
    };
  }

  public insertUnsafe<TRecord extends Record<string, any>>(req: {
    name: string;
    table: string;
    settings?: ClickHouseSettings;
  }): (events: TRecord | TRecord[]) => Promise<Result<InsertResult, InsertError>> {
    return async (events: TRecord | TRecord[]) => {
      return [
        null,
        {
          executed: true,
          query_id: "noop",
          summary: {
            read_rows: "0",
            read_bytes: "0",
            written_rows: "0",
            written_bytes: "0",
            total_rows_to_read: "0",
            result_rows: "0",
            result_bytes: "0",
            elapsed_ns: "0",
          },
          response_headers: {},
        },
      ];
    };
  }
}
