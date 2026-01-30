import type { ClickHouseSettings } from "@clickhouse/client";
export type { ClickHouseSettings };
import { ClickhouseClient } from "./client/client.js";
import { ClickhouseReader, ClickhouseWriter } from "./client/types.js";
import { NoopClient } from "./client/noop.js";
import {
  insertTaskRunsCompactArrays,
  insertRawTaskRunPayloadsCompactArrays,
  getTaskRunsQueryBuilder,
  getTaskActivityQueryBuilder,
  getCurrentRunningStats,
  getAverageDurations,
  getTaskUsageByOrganization,
  getTaskRunsCountQueryBuilder,
  getTaskRunTagsQueryBuilder,
} from "./taskRuns.js";
import {
  getSpanDetailsQueryBuilder,
  getSpanDetailsQueryBuilderV2,
  getTraceDetailedSummaryQueryBuilder,
  getTraceDetailedSummaryQueryBuilderV2,
  getTraceSummaryQueryBuilder,
  getTraceSummaryQueryBuilderV2,
  insertTaskEvents,
  insertTaskEventsV2,
  getLogsListQueryBuilderV2,
  getLogDetailQueryBuilderV2,
} from "./taskEvents.js";
import { Logger, type LogLevel } from "@trigger.dev/core/logger";
import type { Agent as HttpAgent } from "http";
import type { Agent as HttpsAgent } from "https";

export type * from "./taskRuns.js";
export type * from "./taskEvents.js";
export type * from "./client/queryBuilder.js";

// Re-export column constants, indices, and type-safe accessors
export {
  TASK_RUN_COLUMNS,
  TASK_RUN_INDEX,
  PAYLOAD_COLUMNS,
  PAYLOAD_INDEX,
  getTaskRunField,
  getPayloadField,
} from "./taskRuns.js";

// TSQL query execution
export {
  executeTSQL,
  createTSQLExecutor,
  type ExecuteTSQLOptions,
  type TableSchema,
  type TSQLQueryResult,
  type TSQLQuerySuccess,
  type QueryStats,
  type FieldMappings,
  type WhereClauseCondition,
} from "./client/tsql.js";
export type { OutputColumnMetadata } from "@internal/tsql";

// Errors
export { QueryError } from "./client/errors.js";

export type LogsQuerySettings = {
  list?: ClickHouseSettings;
  detail?: ClickHouseSettings;
};

export type ClickhouseCommonConfig = {
  keepAlive?: {
    enabled?: boolean;
    idleSocketTtl?: number;
  };
  httpAgent?: HttpAgent | HttpsAgent;
  clickhouseSettings?: ClickHouseSettings;
  logger?: Logger;
  logLevel?: LogLevel;
  compression?: {
    request?: boolean;
    response?: boolean;
  };
  maxOpenConnections?: number;
  logsQuerySettings?: LogsQuerySettings;
};

export type ClickHouseConfig =
  | ({
      name?: string;
      url?: string;
      writerUrl?: never;
      readerUrl?: never;
    } & ClickhouseCommonConfig)
  | ({
      name?: never;
      url?: never;
      writerName?: string;
      writerUrl: string;
      readerName?: string;
      readerUrl: string;
    } & ClickhouseCommonConfig);

export class ClickHouse {
  public readonly reader: ClickhouseReader;
  public readonly writer: ClickhouseWriter;
  private readonly logger: Logger;
  private _splitClients: boolean;
  private readonly logsQuerySettings?: LogsQuerySettings;

  constructor(config: ClickHouseConfig) {
    this.logger = config.logger ?? new Logger("ClickHouse", config.logLevel ?? "debug");
    this.logsQuerySettings = config.logsQuerySettings;

    if (config.url) {
      const url = new URL(config.url);
      url.password = "redacted";

      this.logger.info("🏠 Initializing ClickHouse client with url", { url: url.toString() });

      const client = new ClickhouseClient({
        name: config.name ?? "clickhouse",
        url: config.url,
        clickhouseSettings: config.clickhouseSettings,
        logger: this.logger,
        logLevel: config.logLevel,
        keepAlive: config.keepAlive,
        httpAgent: config.httpAgent,
        maxOpenConnections: config.maxOpenConnections,
        compression: config.compression,
      });
      this.reader = client;
      this.writer = client;

      this._splitClients = false;
    } else if (config.writerUrl && config.readerUrl) {
      this.reader = new ClickhouseClient({
        name: config.readerName ?? "clickhouse-reader",
        url: config.readerUrl,
        clickhouseSettings: config.clickhouseSettings,
        logger: this.logger,
        logLevel: config.logLevel,
        keepAlive: config.keepAlive,
        httpAgent: config.httpAgent,
        maxOpenConnections: config.maxOpenConnections,
        compression: config.compression,
      });
      this.writer = new ClickhouseClient({
        name: config.writerName ?? "clickhouse-writer",
        url: config.writerUrl,
        clickhouseSettings: config.clickhouseSettings,
        logger: this.logger,
        logLevel: config.logLevel,
        keepAlive: config.keepAlive,
        httpAgent: config.httpAgent,
        maxOpenConnections: config.maxOpenConnections,
        compression: config.compression,
      });

      this._splitClients = true;
    } else {
      this.reader = new NoopClient();
      this.writer = new NoopClient();

      this._splitClients = true;
    }
  }

  static fromEnv(): ClickHouse {
    if (
      typeof process.env.CLICKHOUSE_WRITER_URL === "string" &&
      typeof process.env.CLICKHOUSE_READER_URL === "string"
    ) {
      return new ClickHouse({
        writerUrl: process.env.CLICKHOUSE_WRITER_URL,
        readerUrl: process.env.CLICKHOUSE_READER_URL,
        writerName: process.env.CLICKHOUSE_WRITER_NAME,
        readerName: process.env.CLICKHOUSE_READER_NAME,
      });
    }

    return new ClickHouse({
      url: process.env.CLICKHOUSE_URL,
      name: process.env.CLICKHOUSE_NAME,
    });
  }

  async close() {
    if (this._splitClients) {
      await Promise.all([this.reader.close(), this.writer.close()]);
    } else {
      await this.reader.close();
    }
  }

  get taskRuns() {
    return {
      insertCompactArrays: insertTaskRunsCompactArrays(this.writer),
      insertPayloadsCompactArrays: insertRawTaskRunPayloadsCompactArrays(this.writer),
      queryBuilder: getTaskRunsQueryBuilder(this.reader),
      countQueryBuilder: getTaskRunsCountQueryBuilder(this.reader),
      tagQueryBuilder: getTaskRunTagsQueryBuilder(this.reader),
      getTaskActivity: getTaskActivityQueryBuilder(this.reader),
      getCurrentRunningStats: getCurrentRunningStats(this.reader),
      getAverageDurations: getAverageDurations(this.reader),
      getTaskUsageByOrganization: getTaskUsageByOrganization(this.reader),
    };
  }

  get taskEvents() {
    return {
      insert: insertTaskEvents(this.writer),
      traceSummaryQueryBuilder: getTraceSummaryQueryBuilder(this.reader),
      traceDetailedSummaryQueryBuilder: getTraceDetailedSummaryQueryBuilder(this.reader),
      spanDetailsQueryBuilder: getSpanDetailsQueryBuilder(this.reader),
    };
  }

  get taskEventsV2() {
    return {
      insert: insertTaskEventsV2(this.writer),
      traceSummaryQueryBuilder: getTraceSummaryQueryBuilderV2(this.reader),
      traceDetailedSummaryQueryBuilder: getTraceDetailedSummaryQueryBuilderV2(this.reader),
      spanDetailsQueryBuilder: getSpanDetailsQueryBuilderV2(this.reader),
      logsListQueryBuilder: getLogsListQueryBuilderV2(this.reader, this.logsQuerySettings?.list),
      logDetailQueryBuilder: getLogDetailQueryBuilderV2(this.reader, this.logsQuerySettings?.detail),
    };
  }
}
