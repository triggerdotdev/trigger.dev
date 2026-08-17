import type { PrismaClient } from "@trigger.dev/database";
import {
  LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE,
  LOGS_SEARCH_PROJECTOR_ID,
  type LogsSearchProjectorCheckpointResult,
  type LogsSearchProjectorControl,
  type LogsSearchProjectorProjectionResult,
  type LogsSearchProjectorStateStore,
  type LogsSearchProjectorWindow,
} from "~/services/logsSearchProjector.server";

type LogsSearchProjectorDatabase = Pick<
  PrismaClient,
  "logsSearchProjectorControl" | "logsSearchProjectorCheckpoint"
>;

export class PrismaLogsSearchProjectorStateStore implements LogsSearchProjectorStateStore {
  constructor(private readonly database: LogsSearchProjectorDatabase) {}

  async initialize(initialWatermark: Date): Promise<LogsSearchProjectorControl> {
    const existing = await this.findControl();
    if (existing) return existing;

    return this.database.logsSearchProjectorControl.upsert({
      where: { id: LOGS_SEARCH_PROJECTOR_ID },
      create: {
        id: LOGS_SEARCH_PROJECTOR_ID,
        initialWatermark,
      },
      update: {},
    });
  }

  async findControl(): Promise<LogsSearchProjectorControl | null> {
    return this.database.logsSearchProjectorControl.findFirst({
      where: { id: LOGS_SEARCH_PROJECTOR_ID },
    });
  }

  async getControl(): Promise<LogsSearchProjectorControl> {
    const control = await this.findControl();
    if (!control) throw new Error("Logs search projector control is not initialized");
    return control;
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

  async pause(): Promise<void> {
    await this.database.logsSearchProjectorControl.update({
      where: { id: LOGS_SEARCH_PROJECTOR_ID },
      data: { paused: true },
    });
  }

  async resume(): Promise<void> {
    await this.database.logsSearchProjectorControl.update({
      where: { id: LOGS_SEARCH_PROJECTOR_ID },
      data: { paused: false },
    });
  }
}
