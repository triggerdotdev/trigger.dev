import { ClickHouse } from "@internal/clickhouse";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { ClickhouseEventRepository } from "./clickhouseEventRepository.server";

export const clickhouseEventRepository = singleton(
  "clickhouseEventRepository",
  initializeClickhouseRepository
);

export const clickhouseEventRepositoryV2 = singleton(
  "clickhouseEventRepositoryV2",
  initializeClickhouseRepositoryV2
);

function getClickhouseClient() {
  if (!env.EVENTS_CLICKHOUSE_URL) {
    throw new Error("EVENTS_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.EVENTS_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  return new ClickHouse({
    url: url.toString(),
    name: "task-events",
    keepAlive: {
      enabled: env.EVENTS_CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.EVENTS_CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.EVENTS_CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: env.EVENTS_CLICKHOUSE_COMPRESSION_REQUEST === "1",
    },
    maxOpenConnections: env.EVENTS_CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

function initializeClickhouseRepository() {
  if (!env.EVENTS_CLICKHOUSE_URL) {
    throw new Error("EVENTS_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.EVENTS_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  const safeUrl = new URL(url.toString());
  safeUrl.password = "redacted";

  console.log("🗃️  Initializing Clickhouse event repository (v1)", { url: safeUrl.toString() });

  const clickhouse = getClickhouseClient();

  const repository = new ClickhouseEventRepository({
    clickhouse: clickhouse,
    batchSize: env.EVENTS_CLICKHOUSE_BATCH_SIZE,
    flushInterval: env.EVENTS_CLICKHOUSE_FLUSH_INTERVAL_MS,
    maximumTraceSummaryViewCount: env.EVENTS_CLICKHOUSE_MAX_TRACE_SUMMARY_VIEW_COUNT,
    maximumTraceDetailedSummaryViewCount:
      env.EVENTS_CLICKHOUSE_MAX_TRACE_DETAILED_SUMMARY_VIEW_COUNT,
    maximumLiveReloadingSetting: env.EVENTS_CLICKHOUSE_MAX_LIVE_RELOADING_SETTING,
    insertStrategy: env.EVENTS_CLICKHOUSE_INSERT_STRATEGY,
    waitForAsyncInsert: env.EVENTS_CLICKHOUSE_WAIT_FOR_ASYNC_INSERT === "1",
    asyncInsertMaxDataSize: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_MAX_DATA_SIZE,
    asyncInsertBusyTimeoutMs: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_BUSY_TIMEOUT_MS,
    startTimeMaxAgeMs: env.EVENTS_CLICKHOUSE_START_TIME_MAX_AGE_MS,
    version: "v1",
  });

  return repository;
}

function initializeClickhouseRepositoryV2() {
  if (!env.EVENTS_CLICKHOUSE_URL) {
    throw new Error("EVENTS_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.EVENTS_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  const safeUrl = new URL(url.toString());
  safeUrl.password = "redacted";

  console.log("🗃️  Initializing Clickhouse event repository (v2)", { url: safeUrl.toString() });

  const clickhouse = getClickhouseClient();

  const repository = new ClickhouseEventRepository({
    clickhouse: clickhouse,
    batchSize: env.EVENTS_CLICKHOUSE_BATCH_SIZE,
    flushInterval: env.EVENTS_CLICKHOUSE_FLUSH_INTERVAL_MS,
    maximumTraceSummaryViewCount: env.EVENTS_CLICKHOUSE_MAX_TRACE_SUMMARY_VIEW_COUNT,
    maximumTraceDetailedSummaryViewCount:
      env.EVENTS_CLICKHOUSE_MAX_TRACE_DETAILED_SUMMARY_VIEW_COUNT,
    maximumLiveReloadingSetting: env.EVENTS_CLICKHOUSE_MAX_LIVE_RELOADING_SETTING,
    insertStrategy: env.EVENTS_CLICKHOUSE_INSERT_STRATEGY,
    waitForAsyncInsert: env.EVENTS_CLICKHOUSE_WAIT_FOR_ASYNC_INSERT === "1",
    asyncInsertMaxDataSize: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_MAX_DATA_SIZE,
    asyncInsertBusyTimeoutMs: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_BUSY_TIMEOUT_MS,
    version: "v2",
  });

  return repository;
}
