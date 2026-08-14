import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { getLogsSearchProjectorClickhouseClient } from "~/services/clickhouse/clickhouseFactory.server";
import { LogsSearchProjector } from "~/services/logsSearchProjector.server";
import { PrismaLogsSearchProjectorStateStore } from "~/services/logsSearchProjectorStateStore.server";
import { singleton } from "~/utils/singleton";
import { z } from "zod";

function initializeLogsSearchProjector() {
  const clickhouse = getLogsSearchProjectorClickhouseClient();
  const serverClockQuery = clickhouse.reader.query({
    name: "get-logs-search-projector-clock",
    query: "SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms",
    schema: z.object({ now_ms: z.number().or(z.string()) }),
  });
  const limits = {
    maxExecutionTimeSeconds: env.LOGS_SEARCH_PROJECTOR_MAX_EXECUTION_TIME_SECONDS,
    maxRowsToRead: env.LOGS_SEARCH_PROJECTOR_MAX_ROWS_TO_READ,
    maxMemoryUsage: env.LOGS_SEARCH_PROJECTOR_MAX_MEMORY_USAGE,
    maxThreads: env.LOGS_SEARCH_PROJECTOR_MAX_THREADS,
  };

  return new LogsSearchProjector(
    {
      safetyDelayMs: env.LOGS_SEARCH_PROJECTOR_SAFETY_DELAY_SECONDS * 1000,
      maxWindowsPerTick: env.LOGS_SEARCH_PROJECTOR_MAX_WINDOWS_PER_TICK,
      leaseDurationMs: env.LOGS_SEARCH_PROJECTOR_MAX_EXECUTION_TIME_SECONDS * 1000 + 60_000,
      backfillEnabled: env.LOGS_SEARCH_PROJECTOR_BACKFILL_ENABLED,
      maxBackfillRangeMs: env.LOGS_SEARCH_PROJECTOR_MAX_BACKFILL_RANGE_DAYS * 24 * 60 * 60 * 1000,
      maxBackfillAgeMs: env.LOGS_SEARCH_PROJECTOR_MAX_BACKFILL_AGE_DAYS * 24 * 60 * 60 * 1000,
    },
    new PrismaLogsSearchProjectorStateStore(prisma),
    async (window) => {
      const [error, result] = await clickhouse.taskEventsSearch.projectV2Window(window, limits);
      if (error) throw error;
      return {
        queryId: result.query_id,
        readRows: Number(result.summary?.read_rows ?? 0),
        writtenRows: Number(result.summary?.written_rows ?? 0),
      };
    },
    async () => {
      const [error, rows] = await serverClockQuery({});
      if (error) throw error;
      const nowMs = Number(rows[0]?.now_ms);
      if (!Number.isFinite(nowMs)) throw new Error("ClickHouse returned an invalid server clock");
      return new Date(nowMs);
    }
  );
}

export function getLogsSearchProjector() {
  return singleton("logsSearchProjector", initializeLogsSearchProjector);
}
