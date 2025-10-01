import { ClickHouse } from "@internal/clickhouse";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { ClickhouseEventRepository } from "./clickhouseEventRepository.server";

export const clickhouseEventRepository = singleton(
  "clickhouseEventRepository",
  initializeClickhouseRepository
);

function initializeClickhouseRepository() {
  if (!env.EVENTS_CLICKHOUSE_URL) {
    throw new Error("EVENTS_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.EVENTS_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  const safeUrl = new URL(url.toString());
  safeUrl.password = "redacted";

  console.log("🗃️  Initializing Clickhouse event repository", { url: safeUrl.toString() });

  const clickhouse = new ClickHouse({
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

  const repository = new ClickhouseEventRepository({
    clickhouse: clickhouse,
    batchSize: env.EVENTS_CLICKHOUSE_BATCH_SIZE,
    flushInterval: env.EVENTS_CLICKHOUSE_FLUSH_INTERVAL_MS,
    maximumTraceSummaryViewCount: env.EVENTS_CLICKHOUSE_MAX_TRACE_SUMMARY_VIEW_COUNT,
    maximumTraceDetailedSummaryViewCount:
      env.EVENTS_CLICKHOUSE_MAX_TRACE_DETAILED_SUMMARY_VIEW_COUNT,
    maximumLiveReloadingSetting: env.EVENTS_CLICKHOUSE_MAX_LIVE_RELOADING_SETTING,
  });

  return repository;
}
