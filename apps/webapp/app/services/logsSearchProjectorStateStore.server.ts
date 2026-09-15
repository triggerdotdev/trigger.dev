import type { PrismaClient } from "@trigger.dev/database";
import {
  LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
  LOGS_SEARCH_PROJECTOR_ID,
  LOGS_SEARCH_PROJECTOR_INITIAL_MODE,
  type LogsSearchProjectorCheckpointResult,
  type LogsSearchProjectorProjectionResult,
  type LogsSearchProjectorStateStore,
  type LogsSearchProjectorWindow,
} from "~/services/logsSearchProjector.server";

type LogsSearchProjectorDatabase = Pick<PrismaClient, "logsSearchProjectorCheckpoint">;

export class PrismaLogsSearchProjectorStateStore implements LogsSearchProjectorStateStore {
  constructor(private readonly database: LogsSearchProjectorDatabase) {}

  async initialize(initialWatermark: Date): Promise<Date> {
    const existing = await this.findInitialWatermark();
    if (existing) return existing;

    await this.database.logsSearchProjectorCheckpoint.createMany({
      data: [
        {
          projectorId: LOGS_SEARCH_PROJECTOR_ID,
          mode: LOGS_SEARCH_PROJECTOR_INITIAL_MODE,
          windowStart: initialWatermark,
          windowEnd: initialWatermark,
        },
      ],
      skipDuplicates: true,
    });

    // Concurrent first ticks can choose adjacent safe boundaries. Starting from the earliest
    // append-only initialization checkpoint preserves complete forward coverage.
    return (await this.findInitialWatermark()) ?? initialWatermark;
  }

  async findInitialWatermark(): Promise<Date | null> {
    const checkpoint = await this.database.logsSearchProjectorCheckpoint.findFirst({
      where: {
        projectorId: LOGS_SEARCH_PROJECTOR_ID,
        mode: LOGS_SEARCH_PROJECTOR_INITIAL_MODE,
      },
      orderBy: { windowEnd: "asc" },
      select: { windowEnd: true },
    });

    return checkpoint?.windowEnd ?? null;
  }

  async getFinalizedWatermark(initialWatermark: Date): Promise<Date> {
    const checkpoint = await this.database.logsSearchProjectorCheckpoint.findFirst({
      where: {
        projectorId: LOGS_SEARCH_PROJECTOR_ID,
        mode: LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
      },
      orderBy: { windowEnd: "desc" },
      select: { windowEnd: true },
    });

    return checkpoint?.windowEnd ?? initialWatermark;
  }

  async appendFinalizedCheckpoint(
    window: LogsSearchProjectorWindow,
    result: LogsSearchProjectorProjectionResult
  ): Promise<LogsSearchProjectorCheckpointResult> {
    const inserted = await this.database.logsSearchProjectorCheckpoint.createMany({
      data: [
        {
          projectorId: LOGS_SEARCH_PROJECTOR_ID,
          mode: LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
          windowStart: window.start,
          windowEnd: window.end,
          queryId: result.queryId,
        },
      ],
      skipDuplicates: true,
    });

    return inserted.count === 1 ? "inserted" : "duplicate";
  }
}
