import type { PrismaClient } from "@trigger.dev/database";
import {
  LOGS_SEARCH_PROJECTOR_STATE_ID,
  type LogsSearchProjectorState,
  type LogsSearchProjectorStateStore,
} from "~/services/logsSearchProjector.server";

type LogsSearchProjectorDatabase = Pick<PrismaClient, "logsSearchProjectorState" | "$executeRaw">;

export class PrismaLogsSearchProjectorStateStore implements LogsSearchProjectorStateStore {
  constructor(private readonly database: LogsSearchProjectorDatabase) {}

  async initialize(boundary: Date): Promise<LogsSearchProjectorState> {
    return this.database.logsSearchProjectorState.upsert({
      where: { id: LOGS_SEARCH_PROJECTOR_STATE_ID },
      create: {
        id: LOGS_SEARCH_PROJECTOR_STATE_ID,
        liveWatermark: boundary,
        historicalWatermark: boundary,
      },
      update: {},
    });
  }

  async find(): Promise<LogsSearchProjectorState | null> {
    return this.database.logsSearchProjectorState.findFirst({
      where: { id: LOGS_SEARCH_PROJECTOR_STATE_ID },
    });
  }

  async get(): Promise<LogsSearchProjectorState> {
    const state = await this.find();
    if (!state) throw new Error("Logs search projector state is not initialized");
    return state;
  }

  async acquireLease(token: string, leaseDurationMs: number): Promise<boolean> {
    const count = await this.database.$executeRaw`
      UPDATE "LogsSearchProjectorState"
      SET
        "leaseToken" = ${token},
        "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseDurationMs} * INTERVAL '1 millisecond'),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${LOGS_SEARCH_PROJECTOR_STATE_ID}
        AND "paused" = false
        AND (
          "leaseToken" IS NULL
          OR "leaseExpiresAt" IS NULL
          OR "leaseExpiresAt" <= CURRENT_TIMESTAMP
        )
    `;
    return count === 1;
  }

  async renewLease(token: string, leaseDurationMs: number): Promise<boolean> {
    const count = await this.database.$executeRaw`
      UPDATE "LogsSearchProjectorState"
      SET
        "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseDurationMs} * INTERVAL '1 millisecond'),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${LOGS_SEARCH_PROJECTOR_STATE_ID}
        AND "paused" = false
        AND "leaseToken" = ${token}
    `;
    return count === 1;
  }

  async releaseLease(token: string): Promise<void> {
    await this.database.logsSearchProjectorState.updateMany({
      where: { id: LOGS_SEARCH_PROJECTOR_STATE_ID, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }

  async advanceLive(token: string, expected: Date, next: Date): Promise<boolean> {
    const result = await this.database.logsSearchProjectorState.updateMany({
      where: {
        id: LOGS_SEARCH_PROJECTOR_STATE_ID,
        paused: false,
        leaseToken: token,
        liveWatermark: expected,
      },
      data: { liveWatermark: next },
    });
    return result.count === 1;
  }

  async advanceHistorical(
    token: string,
    expected: Date,
    next: Date,
    expectedTarget: Date
  ): Promise<boolean> {
    const result = await this.database.logsSearchProjectorState.updateMany({
      where: {
        id: LOGS_SEARCH_PROJECTOR_STATE_ID,
        paused: false,
        leaseToken: token,
        historicalWatermark: expected,
        backfillTarget: expectedTarget,
      },
      data: {
        historicalWatermark: next,
        ...(next.getTime() === expectedTarget.getTime() ? { backfillTarget: null } : {}),
      },
    });
    return result.count === 1;
  }

  async pause(): Promise<void> {
    await this.database.logsSearchProjectorState.update({
      where: { id: LOGS_SEARCH_PROJECTOR_STATE_ID },
      data: { paused: true },
    });
  }

  async resume(): Promise<void> {
    await this.database.logsSearchProjectorState.update({
      where: { id: LOGS_SEARCH_PROJECTOR_STATE_ID },
      data: { paused: false },
    });
  }

  async setBackfillTarget(expectedHistorical: Date, target: Date): Promise<boolean> {
    const result = await this.database.logsSearchProjectorState.updateMany({
      where: {
        id: LOGS_SEARCH_PROJECTOR_STATE_ID,
        historicalWatermark: expectedHistorical,
        backfillTarget: null,
      },
      data: { backfillTarget: target },
    });
    return result.count === 1;
  }

  async cancelBackfill(): Promise<void> {
    await this.database.logsSearchProjectorState.update({
      where: { id: LOGS_SEARCH_PROJECTOR_STATE_ID },
      data: { backfillTarget: null },
    });
  }
}
