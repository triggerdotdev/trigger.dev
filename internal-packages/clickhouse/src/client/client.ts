import {
  type ClickHouseClient,
  ClickHouseError,
  type ClickHouseSettings,
  createClient,
} from "@clickhouse/client";
import { recordSpanError, Span, startSpan, trace, Tracer } from "@internal/tracing";
import { flattenAttributes, tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { InsertError, QueryError } from "./errors.js";
import type {
  ClickhouseInsertFunction,
  ClickhouseQueryFunction,
  ClickhouseReader,
  ClickhouseWriter,
} from "./types.js";
import { generateErrorMessage } from "zod-error";
import { Logger, type LogLevel } from "@trigger.dev/core/logger";
import type { Agent as HttpAgent } from "http";
import type { Agent as HttpsAgent } from "https";

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
  logLevel?: LogLevel;
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
      clickhouse_settings: {
        ...config.clickhouseSettings,
        output_format_json_quote_64bit_integers: 0,
        output_format_json_quote_64bit_floats: 0,
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
      return await startSpan(this.tracer, "query", async (span) => {
        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.operationName": req.name,
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

  public insert<TSchema extends z.ZodSchema<any>>(req: {
    name: string;
    table: string;
    schema: TSchema;
    settings?: ClickHouseSettings;
  }): ClickhouseInsertFunction<z.input<TSchema>> {
    return async (events, options) => {
      return await startSpan(this.tracer, "insert", async (span) => {
        span.setAttributes({
          "clickhouse.clientName": this.name,
          "clickhouse.tableName": req.table,
          "clickhouse.operationName": req.name,
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
