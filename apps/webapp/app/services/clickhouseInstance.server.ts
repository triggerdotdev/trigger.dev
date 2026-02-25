import { ClickHouse } from "@internal/clickhouse";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export const clickhouseClient = singleton("clickhouseClient", initializeClickhouseClient);

function initializeClickhouseClient() {
  const url = new URL(env.CLICKHOUSE_URL);

  // Remove secure param
  url.searchParams.delete("secure");

  console.log(`🗃️  Clickhouse service enabled to host ${url.host}`);

  const clickhouse = new ClickHouse({
    url: url.toString(),
    name: "clickhouse-instance",
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: true,
    },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });

  return clickhouse;
}

export const logsClickhouseClient = singleton(
  "logsClickhouseClient",
  initializeLogsClickhouseClient
);

function initializeLogsClickhouseClient() {
  if (!env.LOGS_CLICKHOUSE_URL) {
    throw new Error("LOGS_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.LOGS_CLICKHOUSE_URL);

  // Remove secure param
  url.searchParams.delete("secure");

  return new ClickHouse({
    url: url.toString(),
    name: "logs-clickhouse",
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: true,
    },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
    clickhouseSettings: {
      max_memory_usage: env.CLICKHOUSE_LOGS_LIST_MAX_MEMORY_USAGE.toString(),
      max_bytes_before_external_sort:
        env.CLICKHOUSE_LOGS_LIST_MAX_BYTES_BEFORE_EXTERNAL_SORT.toString(),
      max_threads: env.CLICKHOUSE_LOGS_LIST_MAX_THREADS,
      ...(env.CLICKHOUSE_LOGS_LIST_MAX_ROWS_TO_READ && {
        max_rows_to_read: env.CLICKHOUSE_LOGS_LIST_MAX_ROWS_TO_READ.toString(),
      }),
      ...(env.CLICKHOUSE_LOGS_LIST_MAX_EXECUTION_TIME && {
        max_execution_time: env.CLICKHOUSE_LOGS_LIST_MAX_EXECUTION_TIME,
      }),
    },
  });
}

export const queryClickhouseClient = singleton(
  "queryClickhouseClient",
  initializeQueryClickhouseClient
);

function initializeQueryClickhouseClient() {
  if (!env.QUERY_CLICKHOUSE_URL) {
    throw new Error("QUERY_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.QUERY_CLICKHOUSE_URL);

  return new ClickHouse({
    url: url.toString(),
    name: "query-clickhouse",
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: true,
    },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}
