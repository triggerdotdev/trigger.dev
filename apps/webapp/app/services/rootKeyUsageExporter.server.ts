import type { MetricsV1Input } from "@internal/clickhouse";
import type { RedisClient } from "~/redis.server";

const ROOT_KEY_USAGE_REPORT_INTERVAL_SECONDS = 60 * 60;

export async function exportRootKeyUsage(
  rows: MetricsV1Input[],
  redis: RedisClient,
  emit: (row: MetricsV1Input) => void,
  outcome: (result: "emitted" | "coalesced" | "error", count: number) => void
): Promise<void> {
  const counts = { emitted: 0, coalesced: 0, error: 0 };
  await Promise.all(
    rows.map(async (row) => {
      try {
        // Gate each signal separately so run-token traffic cannot suppress later root-key use.
        const claimed = await redis.set(
          `root-key-usage:${row.environment_id}:${row.metric_name}`,
          "1",
          "EX",
          ROOT_KEY_USAGE_REPORT_INTERVAL_SECONDS,
          "NX"
        );
        if (claimed !== "OK") {
          counts.coalesced++;
          return;
        }
        emit(row);
        counts.emitted++;
      } catch {
        // No per-replica fallback during a cache outage. Absence must remain unknown.
        counts.error++;
      }
    })
  );
  for (const result of ["emitted", "coalesced", "error"] as const) {
    outcome(result, counts[result]);
  }
}
