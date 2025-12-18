import {
  type ClickHouseClient,
  ClickHouseError,
  ClickHouseLogLevel,
  type ClickHouseSettings,
  createClient,
  type ResultSet,
  type Row,
} from "@clickhouse/client";
import { recordSpanError, Span, startSpan, trace, Tracer } from "@internal/tracing";
import { flattenAttributes, tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { InsertError, QueryError } from "./errors.js";
import type {
  ClickhouseInsertFunction,
  ClickhouseQueryBuilderFastFunction,
  ClickhouseQueryBuilderFunction,
  ClickhouseQueryFunction,
  ClickhouseQueryWithStatsFunction,
  ClickhouseReader,
  ClickhouseWriter,
  ColumnExpression,
  QueryStats,
} from "./types.js";
import { generateErrorMessage } from "zod-error";
import { Logger, type LogLevel } from "@trigger.dev/core/logger";
import type { Agent as HttpAgent } from "http";
import type { Agent as HttpsAgent } from "https";
import { ClickhouseQueryBuilder, ClickhouseQueryFastBuilder } from "./queryBuilder.js";
import { randomUUID } from "node:crypto";

export type ClickhouseConfig = {
  name: string;
  url: string;
  tracer?: Tracer;
  keepAlive?: {
    enabled?: boolean;
    idleSocketTtl?: number;
  };
  httpAgent?: HttpAgent | HttpsAgent;
  clickhouseSettings?: ClickHouseSettings;
  logger?: Logger;
  maxOpenConnections?: number;
  logLevel?: LogLevel;
  compression?: {
    request?: boolean;
    response?: boolean;
  };
};

export class ClickhouseClient implements ClickhouseReader, ClickhouseWriter {
  public readonly client: ClickHouseClient;
  private readonly tracer: Tracer;
  private readonly name: string;
  private readonly logger: Logger;

  constructor(config: ClickhouseConfig) {
    this.name = config.name;
    this.logger = config.logger ?? new Logger("ClickhouseClient", config.logLevel ?? "info");

    this.client = createClient({
      url: config.url,
      keep_alive: config.keepAlive,
      http_agent: config.httpAgent,
      compression: config.compression,
      max_open_connections: config.maxOpenConnections,
      clickhouse_settings: {
        ...config.clickhouseSettings,
        output_format_json_quote_64bit_integers: 0,
        output_format_json_quote_64bit_floats: 0,
        cancel_http_readonly_queries_on_client_close: 1,
      },
      log: {
        level: convertLogLevelToClickhouseLogLevel(config.logLevel),
      },
    });

    this.tracer = config.tracer ?? trace.getTracer("@internal/clickhouse");
  }

  public async close() {
    await this.client.close();
  }

  public query<TIn extends z.ZodSchema<any>, TOut extends z.ZodSchema<any>>(req: {
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
  }): ClickhouseQueryFunction<z.input<TIn>, z.output<TOut>> {
    return async (params, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "query", async (span) => {
        this.logger.debug("Querying clickhouse", {
          name: req.name,
          query: req.query.replace(/\s+/g, " "),
          params,
          settings: req.settings,
          attributes: options?.attributes,
          queryId,
        });

        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.operationName": req.name,
          "clickhouse.queryId": queryId,
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        const validParams = req.params?.safeParse(params);

        if (validParams?.error) {
          recordSpanError(span, validParams.error);

          this.logger.error("Error parsing query params", {
            name: req.name,
            error: validParams.error,
            query: req.query,
            params,
            queryId,
          });

          return [
            new QueryError(`Bad params: ${generateErrorMessage(validParams.error.issues)}`, {
              query: req.query,
            }),
            null,
          ];
        }

        let unparsedRows: Array<TOut> = [];

        const [clickhouseError, res] = await tryCatch(
          this.client.query({
            query: req.query,
            query_params: validParams?.data,
            format: "JSONEachRow",
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error querying clickhouse", {
            name: req.name,
            error: clickhouseError,
            query: req.query,
            params,
            queryId,
          });

          recordClickhouseError(span, clickhouseError);

          return [
            new QueryError(`Unable to query clickhouse: ${clickhouseError.message}`, {
              query: req.query,
            }),
            null,
          ];
        }

        unparsedRows = await res.json();

        span.setAttributes({
          "clickhouse.query_id": res.query_id,
          ...flattenAttributes(res.response_headers, "clickhouse.response_headers"),
        });

        const summaryHeader = res.response_headers["x-clickhouse-summary"];

        if (typeof summaryHeader === "string") {
          span.setAttributes({
            ...flattenAttributes(JSON.parse(summaryHeader), "clickhouse.summary"),
          });
        }

        const parsed = z.array(req.schema).safeParse(unparsedRows);

        if (parsed.error) {
          this.logger.error("Error parsing clickhouse query result", {
            name: req.name,
            error: parsed.error,
            query: req.query,
            params,
            queryId,
          });

          const queryError = new QueryError(generateErrorMessage(parsed.error.issues), {
            query: req.query,
          });

          recordSpanError(span, queryError);

          return [queryError, null];
        }

        span.setAttributes({
          "clickhouse.rows": unparsedRows.length,
        });

        return [null, parsed.data];
      });
    };
  }

  public queryWithStats<TIn extends z.ZodSchema<any>, TOut extends z.ZodSchema<any>>(req: {
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
  }): ClickhouseQueryWithStatsFunction<z.input<TIn>, z.output<TOut>> {
    return async (params, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "queryWithStats", async (span) => {
        this.logger.debug("Querying clickhouse with stats", {
          name: req.name,
          query: req.query.replace(/\s+/g, " "),
          params,
          settings: req.settings,
          attributes: options?.attributes,
          queryId,
        });

        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.operationName": req.name,
          "clickhouse.queryId": queryId,
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        const validParams = req.params?.safeParse(params);

        if (validParams?.error) {
          recordSpanError(span, validParams.error);

          this.logger.error("Error parsing query params", {
            name: req.name,
            error: validParams.error,
            query: req.query,
            params,
            queryId,
          });

          return [
            new QueryError(`Bad params: ${generateErrorMessage(validParams.error.issues)}`, {
              query: req.query,
            }),
            null,
          ];
        }

        let unparsedRows: Array<TOut> = [];

        const [clickhouseError, res] = await tryCatch(
          this.client.query({
            query: req.query,
            query_params: validParams?.data,
            format: "JSONEachRow",
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error querying clickhouse", {
            name: req.name,
            error: clickhouseError,
            query: req.query,
            params,
            queryId,
          });

          recordClickhouseError(span, clickhouseError);

          return [
            new QueryError(`Unable to query clickhouse: ${clickhouseError.message}`, {
              query: req.query,
            }),
            null,
          ];
        }

        unparsedRows = await res.json();

        span.setAttributes({
          "clickhouse.query_id": res.query_id,
          ...flattenAttributes(res.response_headers, "clickhouse.response_headers"),
        });

        // Parse the summary header to get stats
        const summaryHeader = res.response_headers["x-clickhouse-summary"];
        let stats: QueryStats = {
          read_rows: "0",
          read_bytes: "0",
          written_rows: "0",
          written_bytes: "0",
          total_rows_to_read: "0",
          result_rows: "0",
          result_bytes: "0",
          elapsed_ns: "0",
        };

        if (typeof summaryHeader === "string") {
          const parsedSummary = JSON.parse(summaryHeader);
          stats = {
            read_rows: parsedSummary.read_rows ?? "0",
            read_bytes: parsedSummary.read_bytes ?? "0",
            written_rows: parsedSummary.written_rows ?? "0",
            written_bytes: parsedSummary.written_bytes ?? "0",
            total_rows_to_read: parsedSummary.total_rows_to_read ?? "0",
            result_rows: parsedSummary.result_rows ?? "0",
            result_bytes: parsedSummary.result_bytes ?? "0",
            elapsed_ns: parsedSummary.elapsed_ns ?? "0",
          };
          span.setAttributes({
            ...flattenAttributes(parsedSummary, "clickhouse.summary"),
          });
        }

        const parsed = z.array(req.schema).safeParse(unparsedRows);

        if (parsed.error) {
          this.logger.error("Error parsing clickhouse query result", {
            name: req.name,
            error: parsed.error,
            query: req.query,
            params,
            queryId,
          });

          const queryError = new QueryError(generateErrorMessage(parsed.error.issues), {
            query: req.query,
          });

          recordSpanError(span, queryError);

          return [queryError, null];
        }

        span.setAttributes({
          "clickhouse.rows": unparsedRows.length,
        });

        return [null, { rows: parsed.data, stats }];
      });
    };
  }

  public queryFast<TOut extends Record<string, any>, TParams extends Record<string, any>>(req: {
    name: string;
    query: string;
    columns: Array<string | ColumnExpression>;
    settings?: ClickHouseSettings;
  }): ClickhouseQueryFunction<TParams, TOut> {
    return async (params, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "queryFast", async (span) => {
        this.logger.debug("Querying clickhouse fast", {
          name: req.name,
          query: req.query.replace(/\s+/g, " "),
          params,
          settings: req.settings,
          attributes: options?.attributes,
          queryId,
        });

        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.operationName": req.name,
          "clickhouse.queryId": queryId,
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        const [clickhouseError, resultSet] = await tryCatch(
          this.client.query({
            query: req.query,
            query_params: params,
            format: "JSONCompactEachRow",
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error querying clickhouse", {
            name: req.name,
            error: clickhouseError,
            query: req.query,
            params,
            queryId,
          });

          recordClickhouseError(span, clickhouseError);

          return [
            new QueryError(`Unable to query clickhouse: ${clickhouseError.message}`, {
              query: req.query,
            }),
            null,
          ];
        }

        span.setAttributes({
          "clickhouse.query_id": resultSet.query_id,
          ...flattenAttributes(resultSet.response_headers, "clickhouse.response_headers"),
        });

        const summaryHeader = resultSet.response_headers["x-clickhouse-summary"];

        if (typeof summaryHeader === "string") {
          span.setAttributes({
            ...flattenAttributes(JSON.parse(summaryHeader), "clickhouse.summary"),
          });
        }

        const resultRows: Array<TOut> = [];

        for await (const rows of resultSet.stream()) {
          if (rows.length === 0) {
            continue;
          }

          for (const row of rows) {
            const rowData = row.json();

            const hydratedRow: Record<string, any> = {};
            for (let i = 0; i < req.columns.length; i++) {
              const column = req.columns[i];

              if (typeof column === "string") {
                hydratedRow[column] = rowData[i];
              } else {
                hydratedRow[column.name] = rowData[i];
              }
            }
            resultRows.push(hydratedRow as TOut);
          }
        }

        span.setAttributes({
          "clickhouse.rows": resultRows.length,
        });

        return [null, resultRows];
      });
    };
  }

  public queryBuilder<TOut extends z.ZodSchema<any>>(req: {
    name: string;
    baseQuery: string;
    schema: TOut;
    settings?: ClickHouseSettings;
  }): ClickhouseQueryBuilderFunction<z.input<TOut>> {
    return (chSettings) =>
      new ClickhouseQueryBuilder(req.name, req.baseQuery, this, req.schema, {
        ...req.settings,
        ...chSettings?.settings,
      });
  }

  public queryBuilderFast<TOut extends Record<string, any>>(req: {
    name: string;
    table: string;
    columns: string[];
    settings?: ClickHouseSettings;
  }): ClickhouseQueryBuilderFastFunction<TOut> {
    return (chSettings) =>
      new ClickhouseQueryFastBuilder(req.name, req.table, req.columns, this, {
        ...req.settings,
        ...chSettings?.settings,
      });
  }

  public insert<TSchema extends z.ZodSchema<any>>(req: {
    name: string;
    table: string;
    schema: TSchema;
    settings?: ClickHouseSettings;
  }): ClickhouseInsertFunction<z.input<TSchema>> {
    return async (events, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "insert", async (span) => {
        this.logger.debug("Inserting into clickhouse", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          events: Array.isArray(events) ? events.length : 1,
          settings: req.settings,
          attributes: options?.attributes,
          options,
          queryId,
        });

        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.tableName": req.table,
          "clickhouse.operationName": req.name,
          "clickhouse.queryId": queryId,
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        let validatedEvents: z.output<TSchema> | z.output<TSchema>[] | undefined = undefined;

        const v = Array.isArray(events)
          ? req.schema.array().safeParse(events)
          : req.schema.safeParse(events);

        if (!v.success) {
          this.logger.error("Error validating insert events", {
            name: req.name,
            table: req.table,
            error: v.error,
          });

          const error = new InsertError(generateErrorMessage(v.error.issues));

          recordSpanError(span, error);

          return [error, null];
        }

        validatedEvents = v.data;

        const [clickhouseError, result] = await tryCatch(
          this.client.insert({
            table: req.table,
            format: "JSONEachRow",
            values: Array.isArray(validatedEvents) ? validatedEvents : [validatedEvents],
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error inserting into clickhouse", {
            name: req.name,
            error: clickhouseError,
            table: req.table,
          });

          recordClickhouseError(span, clickhouseError);

          return [new InsertError(clickhouseError.message), null];
        }

        this.logger.debug("Inserted into clickhouse", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          result,
          queryId,
        });

        span.setAttributes({
          "clickhouse.query_id": result.query_id,
          "clickhouse.executed": result.executed,
          "clickhouse.summary.read_rows": result.summary?.read_rows,
          "clickhouse.summary.read_bytes": result.summary?.read_bytes,
          "clickhouse.summary.written_rows": result.summary?.written_rows,
          "clickhouse.summary.written_bytes": result.summary?.written_bytes,
          "clickhouse.summary.total_rows_to_read": result.summary?.total_rows_to_read,
          "clickhouse.summary.result_rows": result.summary?.result_rows,
          "clickhouse.summary.result_bytes": result.summary?.result_bytes,
          "clickhouse.summary.elapsed_ns": result.summary?.elapsed_ns,
        });

        return [null, result];
      });
    };
  }

  public insertUnsafe<TRecord extends Record<string, any>>(req: {
    name: string;
    table: string;
    settings?: ClickHouseSettings;
  }): ClickhouseInsertFunction<TRecord> {
    return async (events, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "insert", async (span) => {
        this.logger.debug("Inserting into clickhouse", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          events: Array.isArray(events) ? events.length : 1,
          settings: req.settings,
          attributes: options?.attributes,
          options,
          queryId,
        });

        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.tableName": req.table,
          "clickhouse.operationName": req.name,
          "clickhouse.queryId": queryId,
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        const [clickhouseError, result] = await tryCatch(
          this.client.insert({
            table: req.table,
            format: "JSONEachRow",
            values: Array.isArray(events) ? events : [events],
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error inserting into clickhouse", {
            name: req.name,
            error: clickhouseError,
            table: req.table,
          });

          recordClickhouseError(span, clickhouseError);

          return [new InsertError(clickhouseError.message), null];
        }

        this.logger.debug("Inserted into clickhouse", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          result,
          queryId,
        });

        span.setAttributes({
          "clickhouse.query_id": result.query_id,
          "clickhouse.executed": result.executed,
          "clickhouse.summary.read_rows": result.summary?.read_rows,
          "clickhouse.summary.read_bytes": result.summary?.read_bytes,
          "clickhouse.summary.written_rows": result.summary?.written_rows,
          "clickhouse.summary.written_bytes": result.summary?.written_bytes,
          "clickhouse.summary.total_rows_to_read": result.summary?.total_rows_to_read,
          "clickhouse.summary.result_rows": result.summary?.result_rows,
          "clickhouse.summary.result_bytes": result.summary?.result_bytes,
          "clickhouse.summary.elapsed_ns": result.summary?.elapsed_ns,
        });

        return [null, result];
      });
    };
  }
}

function recordClickhouseError(span: Span, error: Error) {
  if (error instanceof ClickHouseError) {
    span.setAttributes({
      "clickhouse.error.code": error.code,
      "clickhouse.error.message": error.message,
      "clickhouse.error.type": error.type,
    });
    recordSpanError(span, error);
  } else {
    recordSpanError(span, error);
  }
}

function convertLogLevelToClickhouseLogLevel(logLevel?: LogLevel) {
  if (!logLevel) {
    return ClickHouseLogLevel.INFO;
  }

  switch (logLevel) {
    case "debug":
      return ClickHouseLogLevel.DEBUG;
    case "info":
      return ClickHouseLogLevel.INFO;
    case "warn":
      return ClickHouseLogLevel.WARN;
    case "error":
      return ClickHouseLogLevel.ERROR;
    default:
      return ClickHouseLogLevel.INFO;
  }
}
