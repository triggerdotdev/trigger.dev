import { randomUUID } from "node:crypto";
import { logger as defaultLogger } from "~/services/logger.server";
import {
  logsSearchProjectorTelemetry,
  type LogsSearchProjectionMode,
} from "~/services/logsSearchProjectorTelemetry.server";

export const LOGS_SEARCH_PROJECTOR_STATE_ID = "task_events_search_v2";
export const LOGS_SEARCH_PROJECTOR_WINDOW_MS = 60_000;

export type LogsSearchProjectorState = {
  id: string;
  liveWatermark: Date;
  historicalWatermark: Date;
  backfillTarget: Date | null;
  paused: boolean;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
};

export type LogsSearchProjectorWindow = {
  mode: LogsSearchProjectionMode;
  start: Date;
  end: Date;
};

export type LogsSearchProjectorProjectionResult = {
  queryId: string;
  readRows: number;
  writtenRows: number;
};

export type LogsSearchProjectorStatus = {
  initialized: boolean;
  paused: boolean;
  liveWatermark: Date | null;
  safeCutoff: Date | null;
  liveLagMs: number | null;
  liveWindowsDue: number | null;
  historicalWatermark: Date | null;
  backfillTarget: Date | null;
  backfillWindowsRemaining: number;
  leaseExpiresAt: Date | null;
};

export type LogsSearchProjectorConfig = {
  safetyDelayMs: number;
  maxWindowsPerTick: number;
  leaseDurationMs: number;
  backfillEnabled: boolean;
  maxBackfillRangeMs: number;
  maxBackfillAgeMs: number;
};

export type LogsSearchProjectorStateStore = {
  initialize(boundary: Date): Promise<LogsSearchProjectorState>;
  find(): Promise<LogsSearchProjectorState | null>;
  get(): Promise<LogsSearchProjectorState>;
  acquireLease(token: string, leaseDurationMs: number): Promise<boolean>;
  renewLease(token: string, leaseDurationMs: number): Promise<boolean>;
  releaseLease(token: string): Promise<void>;
  advanceLive(token: string, expected: Date, next: Date): Promise<boolean>;
  advanceHistorical(
    token: string,
    expected: Date,
    next: Date,
    expectedTarget: Date
  ): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setBackfillTarget(expectedHistorical: Date, target: Date): Promise<boolean>;
  cancelBackfill(): Promise<void>;
};

export class LogsSearchProjectorConflictError extends Error {}
export class LogsSearchProjectorValidationError extends Error {}

export class LogsSearchProjector {
  constructor(
    private readonly config: LogsSearchProjectorConfig,
    private readonly stateStore: LogsSearchProjectorStateStore,
    private readonly projectWindow: (
      window: LogsSearchProjectorWindow
    ) => Promise<LogsSearchProjectorProjectionResult>,
    private readonly clock: () => Date | Promise<Date> = () => new Date(),
    private readonly logger: Pick<
      typeof defaultLogger,
      "debug" | "info" | "warn" | "error"
    > = defaultLogger
  ) {}

  async processTick(): Promise<{ processed: number; leaseAcquired: boolean }> {
    const now = await this.clock();
    const initialBoundary = calculateClosedWindowBoundary(now, this.config.safetyDelayMs);
    const initialState = await this.stateStore.initialize(initialBoundary);
    this.updateTelemetryState(initialState, initialBoundary);
    if (initialState.paused) return { processed: 0, leaseAcquired: false };

    const leaseToken = randomUUID();
    const acquired = await this.stateStore.acquireLease(leaseToken, this.config.leaseDurationMs);
    if (!acquired) {
      logsSearchProjectorTelemetry.recordLeaseContention();
      return { processed: 0, leaseAcquired: false };
    }

    let processed = 0;
    try {
      for (let index = 0; index < this.config.maxWindowsPerTick; index++) {
        const state = await this.stateStore.get();
        if (state.paused || state.leaseToken !== leaseToken) break;

        const safeCutoff = calculateClosedWindowBoundary(
          await this.clock(),
          this.config.safetyDelayMs
        );
        const window = selectNextProjectionWindow(state, safeCutoff);
        if (!window) break;

        const renewed = await this.stateStore.renewLease(leaseToken, this.config.leaseDurationMs);
        if (!renewed) break;

        const startedAt = Date.now();
        let result: LogsSearchProjectorProjectionResult;
        try {
          result = await this.projectWindow(window);
        } catch (error) {
          logsSearchProjectorTelemetry.recordWindow(window.mode, "error", Date.now() - startedAt);
          this.logger.error("Logs search projection window failed", {
            error,
            mode: window.mode,
            windowStart: window.start,
            windowEnd: window.end,
          });
          throw error;
        }

        const advanced =
          window.mode === "live"
            ? await this.stateStore.advanceLive(leaseToken, window.start, window.end)
            : await this.stateStore.advanceHistorical(
                leaseToken,
                window.end,
                window.start,
                state.backfillTarget!
              );

        if (!advanced) {
          logsSearchProjectorTelemetry.recordCasLoss(window.mode);
          logsSearchProjectorTelemetry.recordWindow(
            window.mode,
            "cas_lost",
            Date.now() - startedAt,
            result.readRows,
            result.writtenRows
          );
          this.logger.warn("Logs search projection watermark compare-and-swap lost", {
            mode: window.mode,
            windowStart: window.start,
            windowEnd: window.end,
            queryId: result.queryId,
          });
          break;
        }

        processed++;
        logsSearchProjectorTelemetry.recordWindow(
          window.mode,
          "success",
          Date.now() - startedAt,
          result.readRows,
          result.writtenRows
        );
        this.logger.info("Projected logs search window", {
          mode: window.mode,
          windowStart: window.start,
          windowEnd: window.end,
          queryId: result.queryId,
          readRows: result.readRows,
          writtenRows: result.writtenRows,
        });
      }
    } finally {
      try {
        await this.stateStore.releaseLease(leaseToken);
      } catch (error) {
        this.logger.warn("Failed to release logs search projector lease", { error });
      }
      try {
        const state = await this.stateStore.get();
        const safeCutoff = calculateClosedWindowBoundary(
          await this.clock(),
          this.config.safetyDelayMs
        );
        this.updateTelemetryState(state, safeCutoff);
      } catch (error) {
        this.logger.warn("Failed to update logs search projector telemetry state", { error });
      }
    }

    return { processed, leaseAcquired: true };
  }

  async status(): Promise<LogsSearchProjectorStatus> {
    return this.readStatus(true);
  }

  async pause(): Promise<LogsSearchProjectorStatus> {
    if (!(await this.stateStore.find())) return uninitializedProjectorStatus();
    await this.stateStore.pause();
    return this.readStatus(false);
  }

  async resume(): Promise<LogsSearchProjectorStatus> {
    if (!(await this.stateStore.find())) {
      throw new LogsSearchProjectorConflictError("Logs search projector is not initialized");
    }
    await this.stateStore.resume();
    return this.readStatus(false);
  }

  async startBackfill(input: { from: Date; to: Date }): Promise<LogsSearchProjectorStatus> {
    if (!this.config.backfillEnabled) {
      throw new LogsSearchProjectorConflictError("Logs search backfill is disabled");
    }
    await this.ensureInitialized();
    assertMinuteBoundary(input.from, "from");
    assertMinuteBoundary(input.to, "to");
    if (input.from >= input.to) {
      throw new LogsSearchProjectorValidationError("Backfill from must be before to");
    }
    if (input.to.getTime() - input.from.getTime() > this.config.maxBackfillRangeMs) {
      throw new LogsSearchProjectorValidationError("Backfill range exceeds the configured limit");
    }
    if (input.from.getTime() < (await this.clock()).getTime() - this.config.maxBackfillAgeMs) {
      throw new LogsSearchProjectorValidationError(
        "Backfill start is older than the configured limit"
      );
    }

    const state = await this.stateStore.get();
    if (state.backfillTarget) {
      throw new LogsSearchProjectorConflictError("A logs search backfill is already active");
    }
    if (input.to.getTime() !== state.historicalWatermark.getTime()) {
      throw new LogsSearchProjectorConflictError(
        "Backfill to must equal the current historical watermark"
      );
    }

    const updated = await this.stateStore.setBackfillTarget(state.historicalWatermark, input.from);
    if (!updated) {
      throw new LogsSearchProjectorConflictError("Logs search projector state changed");
    }
    this.logger.info("Started logs search backfill", input);
    return this.status();
  }

  async cancelBackfill(): Promise<LogsSearchProjectorStatus> {
    if (!(await this.stateStore.find())) return uninitializedProjectorStatus();
    await this.stateStore.cancelBackfill();
    this.logger.info("Cancelled logs search backfill");
    return this.readStatus(false);
  }

  private async readStatus(includeClickHouseClock: boolean) {
    const state = await this.stateStore.find();
    if (!state) return uninitializedProjectorStatus();

    let safeCutoff: Date | null = null;
    if (includeClickHouseClock) {
      try {
        safeCutoff = calculateClosedWindowBoundary(await this.clock(), this.config.safetyDelayMs);
      } catch (error) {
        this.logger.warn("Failed to read ClickHouse clock for logs search projector status", {
          error,
        });
      }
    }
    return projectorStatus(state, safeCutoff, true);
  }

  private async ensureInitialized() {
    await this.stateStore.initialize(
      calculateClosedWindowBoundary(await this.clock(), this.config.safetyDelayMs)
    );
  }

  private updateTelemetryState(state: LogsSearchProjectorState, safeCutoff: Date) {
    const status = projectorStatus(state, safeCutoff, true);
    logsSearchProjectorTelemetry.updateState({
      liveLagMs: status.liveLagMs ?? 0,
      backfillRemaining: status.backfillWindowsRemaining,
      paused: status.paused,
    });
  }
}

export function calculateClosedWindowBoundary(now: Date, safetyDelayMs: number): Date {
  return new Date(
    Math.floor((now.getTime() - safetyDelayMs) / LOGS_SEARCH_PROJECTOR_WINDOW_MS) *
      LOGS_SEARCH_PROJECTOR_WINDOW_MS
  );
}

export function selectNextProjectionWindow(
  state: LogsSearchProjectorState,
  safeCutoff: Date
): LogsSearchProjectorWindow | null {
  if (state.paused) return null;
  if (state.liveWatermark < safeCutoff) {
    return {
      mode: "live",
      start: state.liveWatermark,
      end: new Date(state.liveWatermark.getTime() + LOGS_SEARCH_PROJECTOR_WINDOW_MS),
    };
  }
  if (state.backfillTarget && state.historicalWatermark > state.backfillTarget) {
    return {
      mode: "backfill",
      start: new Date(state.historicalWatermark.getTime() - LOGS_SEARCH_PROJECTOR_WINDOW_MS),
      end: state.historicalWatermark,
    };
  }
  return null;
}

function uninitializedProjectorStatus(): LogsSearchProjectorStatus {
  return {
    initialized: false,
    paused: false,
    liveWatermark: null,
    safeCutoff: null,
    liveLagMs: null,
    liveWindowsDue: null,
    historicalWatermark: null,
    backfillTarget: null,
    backfillWindowsRemaining: 0,
    leaseExpiresAt: null,
  };
}

function projectorStatus(
  state: LogsSearchProjectorState,
  safeCutoff: Date | null,
  initialized: boolean
): LogsSearchProjectorStatus {
  const liveLagMs = safeCutoff
    ? Math.max(0, safeCutoff.getTime() - state.liveWatermark.getTime())
    : null;
  const backfillRemaining = state.backfillTarget
    ? Math.max(
        0,
        Math.floor(
          (state.historicalWatermark.getTime() - state.backfillTarget.getTime()) /
            LOGS_SEARCH_PROJECTOR_WINDOW_MS
        )
      )
    : 0;
  return {
    initialized,
    paused: state.paused,
    liveWatermark: state.liveWatermark,
    safeCutoff,
    liveLagMs,
    liveWindowsDue:
      liveLagMs === null ? null : Math.floor(liveLagMs / LOGS_SEARCH_PROJECTOR_WINDOW_MS),
    historicalWatermark: state.historicalWatermark,
    backfillTarget: state.backfillTarget,
    backfillWindowsRemaining: backfillRemaining,
    leaseExpiresAt: state.leaseExpiresAt,
  };
}

function assertMinuteBoundary(value: Date, field: string) {
  if (
    !Number.isFinite(value.getTime()) ||
    value.getTime() % LOGS_SEARCH_PROJECTOR_WINDOW_MS !== 0
  ) {
    throw new LogsSearchProjectorValidationError(`${field} must be aligned to a UTC minute`);
  }
}
