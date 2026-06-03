// Shared ClickHouse query helpers for analytics tools
// All queries apply the same limits as the query page to prevent resource exhaustion

const QUERY_CLICKHOUSE_MAX_EXECUTION_TIME = 10; // seconds
const QUERY_CLICKHOUSE_MAX_MEMORY_USAGE = 1024 * 1024 * 1024; // 1GB

export const CLICKHOUSE_QUERY_SETTINGS = {
  max_execution_time: QUERY_CLICKHOUSE_MAX_EXECUTION_TIME,
  max_memory_usage: QUERY_CLICKHOUSE_MAX_MEMORY_USAGE,
};

export function formatClickhouseTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").split(".")[0];
}

export function buildTimeRange(period: string | undefined): {
  from: Date;
  to: Date;
} {
  const to = new Date();
  const from = new Date();

  const periods: Record<string, () => void> = {
    "1h": () => from.setHours(from.getHours() - 1),
    "6h": () => from.setHours(from.getHours() - 6),
    "24h": () => from.setDate(from.getDate() - 1),
    "7d": () => from.setDate(from.getDate() - 7),
    "30d": () => from.setDate(from.getDate() - 30),
  };

  if (period && period in periods) {
    periods[period]();
  } else {
    // Default to 24h
    from.setDate(from.getDate() - 1);
  }

  return { from, to };
}
