import {
  type ClickHouseClient,
  ClickHouseError,
  ClickHouseLogLevel,
  type ClickHouseSettings,
  createClient,
  type BaseQueryParams,
  type InsertResult,
} from "@clickhouse/client";
import type { Span, Tracer } from "@internal/tracing";
import { recordSpanError, startSpan, trace } from "@internal/tracing";
import { flattenAttributes, tryCatch, type Result } from "@trigger.dev/core/v3";
import { z } from "zod";
import { InsertError, QueryError } from "./errors.js";
import type {
  ClickhouseCommandFunction,
  ClickhouseInsertFunction,
  ClickhouseQueryBuilderFastFunction,
  ClickhouseQueryBuilderFunction,
  ClickhouseQueryFunction,
  ClickhouseQueryStreamFunction,
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
import { setTimeout as sleep } from "node:timers/promises";

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
  requestTimeoutMs?: number;
  logLevel?: LogLevel;
  compression?: {
    request?: boolean;
    response?: boolean;
  };
  /**
   * Retry behaviour for reads that fail with a transient connection error
   * (e.g. a dead keep-alive socket surfacing as `ECONNRESET`). Only transient
   * connection errors are retried — server-side errors (e.g. SQL errors) are
   * never retried. Defaults to 3 attempts with a short jittered backoff.
   */
  connectionRetry?: {
    /** Total number of attempts, including the first. @default 3 */
    maxAttempts?: number;
    /** Base delay in ms used for the first backoff. @default 100 */
    minDelayMs?: number;
    /** Maximum backoff delay in ms. @default 1000 */
    maxDelayMs?: number;
  };
};

type ResolvedConnectionRetry = {
  maxAttempts: number;
  minDelayMs: number;
  maxDelayMs: number;
};

const DEFAULT_CONNECTION_RETRY: ResolvedConnectionRetry = {
  maxAttempts: 3,
  minDelayMs: 100,
  maxDelayMs: 1000,
};

const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);
const RETRYABLE_MESSAGE_SUBSTRINGS = ["socket hang up", "econnreset", "epipe", "etimedout"];

/**
 * Classifies an error as a transient connection error that is safe to retry.
 *
 * Server-side {@link ClickHouseError}s (e.g. SQL errors) are never retryable,
 * even if their message happens to contain a matching substring. Transient
 * errors are matched by their Node socket error `code` (`ECONNRESET`, `EPIPE`,
 * `ETIMEDOUT`) or by a message substring, and the check unwraps a nested
 * `cause` so it is robust to the transient error being wrapped.
 */
export function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Server-side errors are deterministic failures, not transient — never retry.
  if (error instanceof ClickHouseError) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = error.message?.toLowerCase() ?? "";
  if (RETRYABLE_MESSAGE_SUBSTRINGS.some((substring) => message.includes(substring))) {
    return true;
  }

  // The transient error is sometimes wrapped by a higher-level error.
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) {
    return isRetryableConnectionError(cause);
  }

  return false;
}

/** Full-jitter exponential backoff, bounded by `maxDelayMs`. */
function computeRetryBackoffMs(attempt: number, minDelayMs: number, maxDelayMs: number): number {
  if (minDelayMs <= 0) {
    return 0;
  }
  const exponential = minDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  return Math.round(Math.random() * capped);
}

export class ClickhouseClient implements ClickhouseReader, ClickhouseWriter {
  public readonly client: ClickHouseClient;
  private readonly tracer: Tracer;
  private readonly name: string;
  private readonly logger: Logger;
  private readonly connectionRetry: ResolvedConnectionRetry;

  constructor(config: ClickhouseConfig) {
    this.name = config.name;
    this.logger = config.logger ?? new Logger("ClickhouseClient", config.logLevel ?? "info");
    this.connectionRetry = {
      maxAttempts: config.connectionRetry?.maxAttempts ?? DEFAULT_CONNECTION_RETRY.maxAttempts,
      minDelayMs: config.connectionRetry?.minDelayMs ?? DEFAULT_CONNECTION_RETRY.minDelayMs,
      maxDelayMs: config.connectionRetry?.maxDelayMs ?? DEFAULT_CONNECTION_RETRY.maxDelayMs,
    };

    this.client = createClient({
      url: config.url,
      // `@clickhouse/client` expects snake_case `idle_socket_ttl`; map our
      // camelCase config across so the idle-socket TTL is actually honored.
      keep_alive: config.keepAlive
        ? {
            enabled: config.keepAlive.enabled,
            idle_socket_ttl: config.keepAlive.idleSocketTtl,
          }
        : undefined,
      http_agent: config.httpAgent,
      compression: config.compression,
      max_open_connections: config.maxOpenConnections,
      request_timeout: config.requestTimeoutMs,
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

  /**
   * Runs a read against the underlying client, retrying only on transient
   * connection errors (see {@link isRetryableConnectionError}). This guards
   * against dead keep-alive sockets surfacing as `ECONNRESET` on the first use
   * of a pooled connection. Server-side errors are re-thrown immediately.
   */
  private async queryWithConnectionRetry<T>(
    operationName: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const { maxAttempts, minDelayMs, maxDelayMs } = this.connectionRetry;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;

      try {
        return await fn();
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableConnectionError(error)) {
          throw error;
        }

        const backoffMs = computeRetryBackoffMs(attempt, minDelayMs, maxDelayMs);

        this.logger.warn("Retrying clickhouse query after transient connection error", {
          name: operationName,
          attempt,
          maxAttempts,
          backoffMs,
          error: error instanceof Error ? error.message : String(error),
        });

        if (backoffMs > 0) {
          await sleep(backoffMs);
        }
      }
    }
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
          this.queryWithConnectionRetry(req.name, () =>
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
          )
        );

        if (clickhouseError) {
          const errorLogFields = {
            name: req.name,
            error: clickhouseError,
            query: req.query,
            params,
            queryId,
          };

          this.logger.error("Error querying clickhouse", errorLogFields);

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
    /**
     * Extra fields to attach to the error log if the query fails. Use this to
     * record what produced the SQL, e.g. the TSQL a caller actually wrote.
     */
    logFields?: Record<string, unknown>;
    /**
     * Set when the SQL originates from whoever made the request rather than
     * from us. Invalid-SQL rejections are then their mistake, not a bug.
     */
    userAuthoredQuery?: boolean;
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
          this.queryWithConnectionRetry(req.name, () =>
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
          )
        );

        if (clickhouseError) {
          const errorLogFields = {
            ...req.logFields,
            name: req.name,
            error: clickhouseError,
            query: req.query,
            params,
            queryId,
          };

          switch (classifyClickhouseError(clickhouseError, req.userAuthoredQuery)) {
            case "quota":
              this.logger.warn("Query exceeded a ClickHouse limit", errorLogFields);
              break;
            case "invalid-sql":
              this.logger.warn("ClickHouse rejected an invalid query", errorLogFields);
              break;
            default:
              this.logger.error("Error querying clickhouse", errorLogFields);
          }

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
          byte_seconds: "0",
        };

        if (typeof summaryHeader === "string") {
          const parsedSummary = JSON.parse(summaryHeader);
          this.logger.debug("parsedSummary", parsedSummary);
          const readBytes = parsedSummary.read_bytes ? parseInt(parsedSummary.read_bytes, 10) : 0;
          const elapsedNs = parsedSummary.elapsed_ns ? parseInt(parsedSummary.elapsed_ns, 10) : 0;
          const elapsedSeconds = elapsedNs / 1_000_000_000;
          const byteSeconds = elapsedSeconds > 0 ? readBytes / elapsedSeconds : 0;
          stats = {
            read_rows: parsedSummary.read_rows ?? "0",
            read_bytes: parsedSummary.read_bytes ?? "0",
            written_rows: parsedSummary.written_rows ?? "0",
            written_bytes: parsedSummary.written_bytes ?? "0",
            total_rows_to_read: parsedSummary.total_rows_to_read ?? "0",
            result_rows: parsedSummary.result_rows ?? "0",
            result_bytes: parsedSummary.result_bytes ?? "0",
            elapsed_ns: parsedSummary.elapsed_ns ?? "0",
            byte_seconds: byteSeconds.toString(),
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
          this.queryWithConnectionRetry(req.name, () =>
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
          )
        );

        if (clickhouseError) {
          const errorLogFields = {
            name: req.name,
            error: clickhouseError,
            query: req.query,
            params,
            queryId,
          };

          this.logger.error("Error querying clickhouse", errorLogFields);

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
            const rowData = row.json() as any[];

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

  public queryFastStream<
    TOut extends Record<string, any>,
    TParams extends Record<string, any>,
  >(req: {
    name: string;
    query: string;
    columns: Array<string | ColumnExpression>;
    settings?: ClickHouseSettings;
  }): ClickhouseQueryStreamFunction<TParams, TOut> {
    // eslint-disable-next-line no-this-alias
    const self = this;

    return async function* (params, options) {
      const queryId = randomUUID();

      // A generator yields across the await boundary, so we can't use the
      // callback-style `startSpan` helper here. We start the span manually and
      // end it in `finally` so the span covers the whole stream lifetime and is
      // closed even if the consumer abandons the generator early. Errors are
      // re-thrown (no Result tuple) since they can surface mid-stream after the
      // response headers have already been sent, but they're still recorded on
      // the span and logged for parity with `queryFast`.
      const span = self.tracer.startSpan("queryFastStream");
      span.setAttributes({
        "clickhouse.clientName": self.name,
        "clickhouse.operationName": req.name,
        "clickhouse.queryId": queryId,
        ...flattenAttributes(req.settings, "clickhouse.settings"),
        ...flattenAttributes(options?.attributes),
      });

      self.logger.debug("Streaming clickhouse fast", {
        name: req.name,
        query: req.query.replace(/\s+/g, " "),
        params,
        settings: req.settings,
        queryId,
      });

      try {
        const resultSet = await self.client.query({
          query: req.query,
          query_params: params,
          format: "JSONCompactEachRow",
          query_id: queryId,
          ...options?.params,
          clickhouse_settings: {
            ...req.settings,
            ...options?.params?.clickhouse_settings,
          },
        });

        span.setAttributes({
          "clickhouse.query_id": resultSet.query_id,
          ...flattenAttributes(resultSet.response_headers, "clickhouse.response_headers"),
        });

        // Stream rows off the socket and hydrate each one on the fly. The full
        // result set is never materialised into an array — bounded memory for
        // arbitrarily large queries.
        let rowCount = 0;
        for await (const rows of resultSet.stream()) {
          for (const row of rows) {
            const rowData = row.json() as any[];

            const hydratedRow: Record<string, any> = {};
            for (let i = 0; i < req.columns.length; i++) {
              const column = req.columns[i];
              if (typeof column === "string") {
                hydratedRow[column] = rowData[i];
              } else {
                hydratedRow[column.name] = rowData[i];
              }
            }

            rowCount++;
            yield hydratedRow as TOut;
          }
        }

        span.setAttributes({ "clickhouse.rows": rowCount });
      } catch (error) {
        const errorLogFields = {
          name: req.name,
          error,
          query: req.query,
          params,
          queryId,
        };

        self.logger.error("Error streaming clickhouse", errorLogFields);

        if (error instanceof Error) {
          recordClickhouseError(span, error);
        }

        throw error;
      } finally {
        span.end();
      }
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

  public command<TSchema extends z.ZodSchema<any>>(req: {
    name: string;
    query: string;
    params?: TSchema;
    settings?: ClickHouseSettings;
  }): ClickhouseCommandFunction<z.input<TSchema>> {
    return async (params, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "command", async (span) => {
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
          return [
            new QueryError(`Bad params: ${generateErrorMessage(validParams.error.issues)}`, {
              query: req.query,
            }),
            null,
          ];
        }

        this.logger.debug("Running clickhouse command", {
          clientName: this.name,
          name: req.name,
          query: req.query.replace(/\s+/g, " "),
          settings: req.settings,
          attributes: options?.attributes,
          queryId,
        });

        const [clickhouseError, result] = await tryCatch(
          this.client.command({
            query: req.query,
            query_params: validParams?.data,
            query_id: queryId,
            ...options?.params,
            clickhouse_settings: {
              ...req.settings,
              ...options?.params?.clickhouse_settings,
            },
          })
        );

        if (clickhouseError) {
          this.logger.error("Error running clickhouse command", {
            name: req.name,
            error: clickhouseError,
            query: req.query,
            queryId,
          });
          recordClickhouseError(span, clickhouseError);
          return [
            new QueryError(`Unable to run clickhouse command: ${clickhouseError.message}`, {
              query: req.query,
            }),
            null,
          ];
        }

        span.setAttributes({
          "clickhouse.query_id": result.query_id,
          "clickhouse.summary.read_rows": result.summary?.read_rows,
          "clickhouse.summary.read_bytes": result.summary?.read_bytes,
          "clickhouse.summary.written_rows": result.summary?.written_rows,
          "clickhouse.summary.written_bytes": result.summary?.written_bytes,
          "clickhouse.summary.elapsed_ns": result.summary?.elapsed_ns,
          ...flattenAttributes(result.response_headers, "clickhouse.response_headers"),
        });

        return [null, result];
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

          return [toInsertError(clickhouseError), null];
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

  public insertCompact<TRecord extends Record<string, any>>(req: {
    name: string;
    table: string;
    columns: readonly string[];
    toArray: (record: TRecord) => any[];
    settings?: ClickHouseSettings;
  }): ClickhouseInsertFunction<TRecord> {
    return async (events, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "insert", async (span) => {
        const eventsArray = Array.isArray(events) ? events : [events];

        this.logger.debug("Inserting into clickhouse (compact)", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          events: eventsArray.length,
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
          "clickhouse.format": "JSONCompactEachRowWithNames",
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        // Build compact format: [columns, ...rows]
        const compactData: any[] = [Array.from(req.columns)];
        for (const event of eventsArray) {
          compactData.push(req.toArray(event));
        }

        const [clickhouseError, result] = await tryCatch(
          this.client.insert({
            table: req.table,
            format: "JSONCompactEachRowWithNames",
            values: compactData,
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
          return [toInsertError(clickhouseError), null];
        }

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
        const eventsArray = Array.isArray(events) ? events : [events];

        this.logger.debug("Inserting into clickhouse", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          events: eventsArray.length,
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
            values: eventsArray,
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

          return [toInsertError(clickhouseError), null];
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

  public insertCompactRaw(req: {
    name: string;
    table: string;
    columns: readonly string[];
    settings?: ClickHouseSettings;
  }): (
    events: readonly any[][] | any[],
    options?: {
      attributes?: Record<string, string | number | boolean>;
      params?: BaseQueryParams;
    }
  ) => Promise<Result<InsertResult, InsertError>> {
    return async (events, options) => {
      const queryId = randomUUID();

      return await startSpan(this.tracer, "insert", async (span) => {
        // Check if events is a single row (array) or multiple rows (array of arrays)
        // If first element is not an array, treat as single row
        const isSingleRow = events.length > 0 && !Array.isArray(events[0]);
        const eventsArray: readonly any[][] = isSingleRow
          ? [events as any[]]
          : (events as readonly any[][]);

        this.logger.debug("Inserting into clickhouse (compact raw)", {
          clientName: this.name,
          name: req.name,
          table: req.table,
          events: eventsArray.length,
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
          "clickhouse.format": "JSONCompactEachRowWithNames",
          ...flattenAttributes(req.settings, "clickhouse.settings"),
          ...flattenAttributes(options?.attributes),
        });

        // Build compact format: [columns, ...rows]
        // Data is already in array format, no conversion needed
        const compactData: any[] = [Array.from(req.columns), ...eventsArray];

        const [clickhouseError, result] = await tryCatch(
          this.client.insert({
            table: req.table,
            format: "JSONCompactEachRowWithNames",
            values: compactData,
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
          return [toInsertError(clickhouseError), null];
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

/**
 * ClickHouse error types raised by a query that is valid but asks for more than
 * it is allowed to spend. Only downgraded for SQL the caller wrote: a runaway
 * query we generated is our bug and still has to alert.
 */
const CLICKHOUSE_QUOTA_ERROR_TYPES = new Set([
  "MEMORY_LIMIT_EXCEEDED",
  "TIMEOUT_EXCEEDED",
  "TOO_SLOW",
  "TOO_MANY_ROWS",
  "TOO_MANY_BYTES",
  "TOO_MANY_ROWS_OR_BYTES",
]);

/**
 * ClickHouse error types that mean the SQL itself is wrong. Only treated as the
 * caller's fault when the query was written by the caller — the same error on a
 * query we generated is our bug and has to keep alerting.
 */
const CLICKHOUSE_INVALID_SQL_ERROR_TYPES = new Set([
  "NOT_AN_AGGREGATE",
  "ILLEGAL_AGGREGATION",
  "UNKNOWN_IDENTIFIER",
  "UNKNOWN_FUNCTION",
  "UNKNOWN_TABLE",
  "AMBIGUOUS_COLUMN_NAME",
  "MULTIPLE_EXPRESSIONS_FOR_ALIAS",
  "SYNTAX_ERROR",
  "BAD_ARGUMENTS",
  "TYPE_MISMATCH",
  "NO_COMMON_TYPE",
  "ILLEGAL_TYPE_OF_ARGUMENT",
  "ILLEGAL_COLUMN",
  "CANNOT_CONVERT_TYPE",
  "CANNOT_PARSE_TEXT",
  "CANNOT_PARSE_NUMBER",
  "CANNOT_PARSE_DATE",
  "CANNOT_PARSE_DATETIME",
  "CANNOT_PARSE_INPUT_ASSERTION_FAILED",
]);

type ClickhouseErrorCategory = "quota" | "invalid-sql" | "fault";

function classifyClickhouseError(
  error: Error,
  userAuthoredQuery: boolean | undefined
): ClickhouseErrorCategory {
  if (!userAuthoredQuery || !(error instanceof ClickHouseError) || error.type === undefined) {
    return "fault";
  }
  if (CLICKHOUSE_QUOTA_ERROR_TYPES.has(error.type)) {
    return "quota";
  }
  if (CLICKHOUSE_INVALID_SQL_ERROR_TYPES.has(error.type)) {
    return "invalid-sql";
  }
  return "fault";
}

function toInsertError(error: Error): InsertError {
  const rawMessage = error instanceof ClickHouseError ? error.rawMessage : undefined;
  return new InsertError(error.message, { rawMessage });
}

function recordClickhouseError(span: Span, error: Error): void {
  if (error instanceof ClickHouseError) {
    span.setAttributes({
      "clickhouse.error.code": error.code,
      "clickhouse.error.message": error.message,
      "clickhouse.error.type": error.type,
    });
  }
  recordSpanError(span, error);
}

function convertLogLevelToClickhouseLogLevel(logLevel?: LogLevel): ClickHouseLogLevel {
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
