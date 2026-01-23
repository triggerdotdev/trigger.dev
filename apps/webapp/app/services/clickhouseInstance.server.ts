import { ClickHouse } from "@internal/clickhouse";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export const clickhouseClient = singleton("clickhouseClient", initializeClickhouseClient);

function initializeClickhouseClient() {
  const url = new URL(env.CLICKHOUSE_URL);

  // Remove secure param
  url.searchParams.delete("secure");

  console.log(`🗃️  Clickhouse service enabled to host ${url.host}`);

  // Build logs query settings from environment variables
  const logsQuerySettings = {
    list: {
      max_memory_usage: env.CLICKHOUSE_LOGS_LIST_MAX_MEMORY_USAGE.toString(),
      max_bytes_before_external_sort: env.CLICKHOUSE_LOGS_LIST_MAX_BYTES_BEFORE_EXTERNAL_SORT.toString(),
      max_threads: env.CLICKHOUSE_LOGS_LIST_MAX_THREADS,
      ...(env.CLICKHOUSE_LOGS_LIST_MAX_ROWS_TO_READ && {
        max_rows_to_read: env.CLICKHOUSE_LOGS_LIST_MAX_ROWS_TO_READ.toString(),
      }),
      ...(env.CLICKHOUSE_LOGS_LIST_MAX_EXECUTION_TIME && {
        max_execution_time: env.CLICKHOUSE_LOGS_LIST_MAX_EXECUTION_TIME,
      }),
    },
    detail: {
      max_memory_usage: env.CLICKHOUSE_LOGS_DETAIL_MAX_MEMORY_USAGE.toString(),
      max_threads: env.CLICKHOUSE_LOGS_DETAIL_MAX_THREADS,
      ...(env.CLICKHOUSE_LOGS_DETAIL_MAX_EXECUTION_TIME && {
        max_execution_time: env.CLICKHOUSE_LOGS_DETAIL_MAX_EXECUTION_TIME,
      }),
    },
  };

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
    logsQuerySettings,
  });

  return clickhouse;
}
