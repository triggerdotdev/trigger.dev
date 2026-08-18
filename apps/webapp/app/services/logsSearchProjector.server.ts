import { randomUUID } from "node:crypto";
import { logger as defaultLogger } from "~/services/logger.server";
import {
  logsSearchProjectorTelemetry,
  type LogsSearchProjectionMode,
} from "~/services/logsSearchProjectorTelemetry.server";

export type { LogsSearchProjectionMode } from "~/services/logsSearchProjectorTelemetry.server";

export const LOGS_SEARCH_PROJECTOR_ID = "task_events_search_v2";
export const LOGS_SEARCH_PROJECTOR_CHECKPOINT_MODE = "FINALIZED";
const LOGS_SEARCH_PREVIEW_WINDOW_MS = 5_000;
const LOGS_SEARCH_PREVIEW_SAFETY_DELAY_MS = 2_000;
const LOGS_SEARCH_FINALIZED_WINDOW_MS = 60_000;
const LOGS_SEARCH_FINALIZED_SAFETY_DELAY_MS = 120_000;

export type LogsSearchProjectorControl = {
  id: string;
  initialWatermark: Date;
  paused: boolean;
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

export type LogsSearchProjectorCheckpointResult = "inserted" | "duplicate";

export type LogsSearchProjectorLeaseStatus = {
  mode: LogsSearchProjectionMode;
  expiresAt: Date;
};

export type LogsSearchProjectorStatus = {
  initialized: boolean;
  paused: boolean;
  previewEnabled: boolean;
  previewWatermark: Date | null;
  previewSafeCutoff: Date | null;
  previewLagMs: number | null;
  finalizedWatermark: Date | null;
  finalizedSafeCutoff: Date | null;
  finalizedLagMs: number | null;
  finalizedWindowsDue: number | null;
  activeProjectionMode: LogsSearchProjectionMode | null;
  leaseExpiresAt: Date | null;
};

export type LogsSearchProjectorConfig = {
  previewEnabled: boolean;
  maxFinalizedWindowsPerTick: number;
  leaseDurationMs: number;
};

export type LogsSearchProjectorStateStore = {
  initialize(initialWatermark: Date): Promise<LogsSearchProjectorControl>;
  findControl(): Promise<LogsSearchProjectorControl | null>;
  getControl(): Promise<LogsSearchProjectorControl>;
  getFinalizedWatermark(initialWatermark: Date): Promise<Date>;
  appendFinalizedCheckpoint(
    window: LogsSearchProjectorWindow,
    result: LogsSearchProjectorProjectionResult
  ): Promise<LogsSearchProjectorCheckpointResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;
};

export type LogsSearchProjectorRedisStore = {
  acquireLease(token: string, mode: LogsSearchProjectionMode, durationMs: number): Promise<boolean>;
  releaseLease(token: string, mode: LogsSearchProjectionMode): Promise<void>;
  readLeaseStatus(): Promise<LogsSearchProjectorLeaseStatus | null>;
  initializePreviewWatermark(boundary: Date): Promise<Date>;
  getPreviewWatermark(): Promise<Date | null>;
  advancePreviewWatermark(next: Date): Promise<boolean>;
};

export class LogsSearchProjectorConflictError extends Error {}

export class LogsSearchProjector {
  constructor(
    private readonly config: LogsSearchProjectorConfig,
    private readonly stateStore: LogsSearchProjectorStateStore,
    private readonly redisStore: LogsSearchProjectorRedisStore,
    private readonly projectWindow: (
      window: LogsSearchProjectorWindow
    ) => Promise<LogsSearchProjectorProjectionResult>,
    private readonly clock: () => Date | Promise<Date> = () => new Date(),
    private readonly logger: Pick<
      typeof defaultLogger,
      "debug" | "info" | "warn" | "error"
    > = defaultLogger
  ) {}

  async processTick(): Promise<{ finalized: number; preview: boolean }> {
    const now = await this.clock();
    const finalizedCutoff = finalizedSafeCutoff(now);
    const existingControl = await this.stateStore.findControl();
    const control = existingControl ?? (await this.stateStore.initialize(finalizedCutoff));

    if (control.paused) {
      await this.updateTelemetryState(now, control);
      return { finalized: 0, preview: false };
    }

    let finalized: number;
    try {
      finalized = await this.processFinalizedWindows(finalizedCutoff);
    } catch (error) {
      await this.updateTelemetryStateAfterFailure(now, control);
      throw error;
    }

    const refreshedControl = await this.stateStore.getControl();
    const currentNow = await this.clock();
    const currentFinalizedCutoff = finalizedSafeCutoff(currentNow);
    const finalizedWatermark = await this.stateStore.getFinalizedWatermark(
      refreshedControl.initialWatermark
    );

    let preview = false;
    if (
      this.config.previewEnabled &&
      !refreshedControl.paused &&
      finalizedWatermark >= currentFinalizedCutoff
    ) {
      preview = await this.processPreviewWindow(previewSafeCutoff(currentNow));
    }

    await this.updateTelemetryState(currentNow, await this.stateStore.getControl());
    return { finalized, preview };
  }

  async status(): Promise<LogsSearchProjectorStatus> {
    return this.readStatus(true);
  }

  async pause(): Promise<LogsSearchProjectorStatus> {
    if (!(await this.stateStore.findControl())) {
      throw new LogsSearchProjectorConflictError("Logs search projector is not initialized");
    }
    await this.stateStore.pause();
    return this.readStatus(false);
  }

  async resume(): Promise<LogsSearchProjectorStatus> {
    if (!(await this.stateStore.findControl())) {
      throw new LogsSearchProjectorConflictError("Logs search projector is not initialized");
    }
    await this.stateStore.resume();
    return this.readStatus(false);
  }

  private async processFinalizedWindows(cutoff: Date): Promise<number> {
    let processed = 0;

    for (let index = 0; index < this.config.maxFinalizedWindowsPerTick; index++) {
      const token = randomUUID();
      const acquired = await this.redisStore.acquireLease(
        token,
        "finalized",
        this.config.leaseDurationMs
      );
      if (!acquired) {
        logsSearchProjectorTelemetry.recordLeaseContention("finalized");
        break;
      }

      let shouldStop = false;
      try {
        const control = await this.stateStore.getControl();
        if (control.paused) break;

        const watermark = await this.stateStore.getFinalizedWatermark(control.initialWatermark);
        const window = selectFinalizedWindow(watermark, cutoff);
        if (!window) break;

        const result = await this.project(window);
        const checkpoint = await this.stateStore.appendFinalizedCheckpoint(window, result);
        if (checkpoint === "duplicate") {
          logsSearchProjectorTelemetry.recordCheckpointConflict();
          this.logger.warn("Logs search finalized checkpoint already exists", {
            windowStart: window.start,
            windowEnd: window.end,
            queryId: result.queryId,
          });
          shouldStop = true;
        } else {
          processed++;
          this.logger.info("Projected finalized logs search window", {
            windowStart: window.start,
            windowEnd: window.end,
            queryId: result.queryId,
            readRows: result.readRows,
            writtenRows: result.writtenRows,
          });
        }
      } finally {
        await this.releaseLease(token, "finalized");
      }

      if (shouldStop) break;
    }

    return processed;
  }

  private async processPreviewWindow(cutoff: Date): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.redisStore.acquireLease(
      token,
      "preview",
      this.config.leaseDurationMs
    );
    if (!acquired) {
      logsSearchProjectorTelemetry.recordLeaseContention("preview");
      return false;
    }

    try {
      const control = await this.stateStore.getControl();
      if (control.paused) return false;

      const watermark = await this.redisStore.initializePreviewWatermark(cutoff);
      const selection = selectPreviewWindow(watermark, cutoff);
      if (!selection.window) return false;

      if (selection.skippedWindows > 0) {
        await this.redisStore.advancePreviewWatermark(selection.window.start);
        logsSearchProjectorTelemetry.recordPreviewSkipped(selection.skippedWindows);
        this.logger.warn("Skipped stale logs search preview windows", {
          skippedWindows: selection.skippedWindows,
          previousWatermark: watermark,
          nextWindowStart: selection.window.start,
        });
      }

      try {
        const result = await this.project(selection.window);
        await this.redisStore.advancePreviewWatermark(selection.window.end);
        this.logger.debug("Projected preview logs search window", {
          windowStart: selection.window.start,
          windowEnd: selection.window.end,
          queryId: result.queryId,
          readRows: result.readRows,
          writtenRows: result.writtenRows,
        });
        return true;
      } catch (error) {
        this.logger.error("Logs search preview projection failed", {
          error,
          windowStart: selection.window.start,
          windowEnd: selection.window.end,
        });
        return false;
      }
    } finally {
      await this.releaseLease(token, "preview");
    }
  }

  private async project(
    window: LogsSearchProjectorWindow
  ): Promise<LogsSearchProjectorProjectionResult> {
    const startedAt = Date.now();
    try {
      const result = await this.projectWindow(window);
      logsSearchProjectorTelemetry.recordWindow(
        window.mode,
        "success",
        Date.now() - startedAt,
        result.readRows,
        result.writtenRows
      );
      return result;
    } catch (error) {
      logsSearchProjectorTelemetry.recordWindow(window.mode, "error", Date.now() - startedAt);
      if (window.mode === "finalized") {
        this.logger.error("Logs search finalized projection failed", {
          error,
          windowStart: window.start,
          windowEnd: window.end,
        });
      }
      throw error;
    }
  }

  private async releaseLease(token: string, mode: LogsSearchProjectionMode): Promise<void> {
    try {
      await this.redisStore.releaseLease(token, mode);
    } catch (error) {
      this.logger.warn("Failed to release logs search projector lease", { error, mode });
    }
  }

  private async readStatus(includeClickHouseClock: boolean): Promise<LogsSearchProjectorStatus> {
    const control = await this.stateStore.findControl();
    if (!control) return uninitializedProjectorStatus(this.config.previewEnabled);

    let now: Date | null = null;
    if (includeClickHouseClock) {
      try {
        now = await this.clock();
      } catch (error) {
        this.logger.warn("Failed to read ClickHouse clock for logs search projector status", {
          error,
        });
      }
    }

    return this.buildStatus(control, now);
  }

  private async buildStatus(
    control: LogsSearchProjectorControl,
    now: Date | null
  ): Promise<LogsSearchProjectorStatus> {
    const finalizedWatermark = await this.stateStore.getFinalizedWatermark(
      control.initialWatermark
    );
    let previewWatermark: Date | null = null;
    let lease: LogsSearchProjectorLeaseStatus | null = null;

    try {
      [previewWatermark, lease] = await Promise.all([
        this.redisStore.getPreviewWatermark(),
        this.redisStore.readLeaseStatus(),
      ]);
    } catch (error) {
      this.logger.warn("Failed to read Redis logs search projector status", { error });
    }

    const previewCutoff = now ? previewSafeCutoff(now) : null;
    const finalizedCutoff = now ? finalizedSafeCutoff(now) : null;
    const previewLagMs = lagMs(previewWatermark, previewCutoff);
    const finalizedLagMs = lagMs(finalizedWatermark, finalizedCutoff);

    return {
      initialized: true,
      paused: control.paused,
      previewEnabled: this.config.previewEnabled,
      previewWatermark,
      previewSafeCutoff: previewCutoff,
      previewLagMs,
      finalizedWatermark,
      finalizedSafeCutoff: finalizedCutoff,
      finalizedLagMs,
      finalizedWindowsDue:
        finalizedLagMs === null
          ? null
          : Math.floor(finalizedLagMs / LOGS_SEARCH_FINALIZED_WINDOW_MS),
      activeProjectionMode: lease?.mode ?? null,
      leaseExpiresAt: lease?.expiresAt ?? null,
    };
  }

  private async updateTelemetryStateAfterFailure(
    now: Date,
    control: LogsSearchProjectorControl
  ): Promise<void> {
    try {
      await this.updateTelemetryState(now, control);
    } catch (error) {
      this.logger.warn("Failed to refresh logs search projector telemetry after tick failure", {
        error,
      });
    }
  }

  private async updateTelemetryState(
    now: Date,
    control: LogsSearchProjectorControl
  ): Promise<void> {
    const status = await this.buildStatus(control, now);
    logsSearchProjectorTelemetry.updateState({
      previewLagMs: status.previewLagMs,
      finalizedLagMs: status.finalizedLagMs ?? 0,
      paused: status.paused,
    });
  }
}

function calculateClosedWindowBoundary(now: Date, safetyDelayMs: number, windowMs: number): Date {
  return new Date(Math.floor((now.getTime() - safetyDelayMs) / windowMs) * windowMs);
}

export function previewSafeCutoff(now: Date): Date {
  return calculateClosedWindowBoundary(
    now,
    LOGS_SEARCH_PREVIEW_SAFETY_DELAY_MS,
    LOGS_SEARCH_PREVIEW_WINDOW_MS
  );
}

export function finalizedSafeCutoff(now: Date): Date {
  return calculateClosedWindowBoundary(
    now,
    LOGS_SEARCH_FINALIZED_SAFETY_DELAY_MS,
    LOGS_SEARCH_FINALIZED_WINDOW_MS
  );
}

export function selectFinalizedWindow(
  watermark: Date,
  safeCutoff: Date
): LogsSearchProjectorWindow | null {
  if (watermark >= safeCutoff) return null;
  return {
    mode: "finalized",
    start: watermark,
    end: new Date(watermark.getTime() + LOGS_SEARCH_FINALIZED_WINDOW_MS),
  };
}

export function selectPreviewWindow(
  watermark: Date,
  safeCutoff: Date
): { window: LogsSearchProjectorWindow | null; skippedWindows: number } {
  if (watermark >= safeCutoff) return { window: null, skippedWindows: 0 };

  const latestWindowStart = new Date(safeCutoff.getTime() - LOGS_SEARCH_PREVIEW_WINDOW_MS);
  const start = watermark < latestWindowStart ? latestWindowStart : watermark;
  return {
    window: {
      mode: "preview",
      start,
      end: new Date(start.getTime() + LOGS_SEARCH_PREVIEW_WINDOW_MS),
    },
    skippedWindows: Math.max(
      0,
      Math.floor((start.getTime() - watermark.getTime()) / LOGS_SEARCH_PREVIEW_WINDOW_MS)
    ),
  };
}

function lagMs(watermark: Date | null, cutoff: Date | null): number | null {
  if (!watermark || !cutoff) return null;
  return Math.max(0, cutoff.getTime() - watermark.getTime());
}

function uninitializedProjectorStatus(previewEnabled: boolean): LogsSearchProjectorStatus {
  return {
    initialized: false,
    paused: false,
    previewEnabled,
    previewWatermark: null,
    previewSafeCutoff: null,
    previewLagMs: null,
    finalizedWatermark: null,
    finalizedSafeCutoff: null,
    finalizedLagMs: null,
    finalizedWindowsDue: null,
    activeProjectionMode: null,
    leaseExpiresAt: null,
  };
}
