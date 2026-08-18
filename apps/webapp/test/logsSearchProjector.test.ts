import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizedSafeCutoff,
  LogsSearchProjector,
  previewSafeCutoff,
  selectFinalizedWindow,
  selectPreviewWindow,
  type LogsSearchProjectorRedisStore,
  type LogsSearchProjectorStateStore,
} from "~/services/logsSearchProjector.server";

const telemetry = vi.hoisted(() => ({
  recordWindow: vi.fn(),
  recordLeaseContention: vi.fn(),
  recordCheckpointConflict: vi.fn(),
  recordPreviewSkipped: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock("~/services/logsSearchProjectorTelemetry.server", () => ({
  logsSearchProjectorTelemetry: telemetry,
}));

const at = (value: string) => new Date(value);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("logs search projector window selection", () => {
  it("floors preview work to a closed five-second boundary", () => {
    expect(previewSafeCutoff(at("2026-08-14T12:10:09.999Z")).toISOString()).toBe(
      "2026-08-14T12:10:05.000Z"
    );
  });

  it("floors finalized work to a closed minute after the safety delay", () => {
    expect(finalizedSafeCutoff(at("2026-08-14T12:10:59.999Z")).toISOString()).toBe(
      "2026-08-14T12:08:00.000Z"
    );
  });

  it("selects finalized windows sequentially", () => {
    expect(
      selectFinalizedWindow(at("2026-08-14T12:05:00.000Z"), at("2026-08-14T12:08:00.000Z"))
    ).toEqual({
      mode: "finalized",
      start: at("2026-08-14T12:05:00.000Z"),
      end: at("2026-08-14T12:06:00.000Z"),
    });
  });

  it("selects the next preview window when caught up", () => {
    expect(
      selectPreviewWindow(at("2026-08-14T12:10:00.000Z"), at("2026-08-14T12:10:05.000Z"))
    ).toEqual({
      window: {
        mode: "preview",
        start: at("2026-08-14T12:10:00.000Z"),
        end: at("2026-08-14T12:10:05.000Z"),
      },
      skippedWindows: 0,
    });
  });

  it("skips stale preview backlog and selects only the newest eligible window", () => {
    expect(
      selectPreviewWindow(at("2026-08-14T12:09:40.000Z"), at("2026-08-14T12:10:05.000Z"))
    ).toEqual({
      window: {
        mode: "preview",
        start: at("2026-08-14T12:10:00.000Z"),
        end: at("2026-08-14T12:10:05.000Z"),
      },
      skippedWindows: 4,
    });
  });

  it("selects no work when each watermark reaches its cutoff", () => {
    const finalized = at("2026-08-14T12:08:00.000Z");
    const preview = at("2026-08-14T12:10:05.000Z");
    expect(selectFinalizedWindow(finalized, finalized)).toBeNull();
    expect(selectPreviewWindow(preview, preview)).toEqual({
      window: null,
      skippedWindows: 0,
    });
  });
});

describe("logs search projector execution", () => {
  it("does no work when the projector is disabled", async () => {
    const initialize = vi.fn(async () => at("2026-08-14T12:00:00.000Z"));
    const projectWindow = vi.fn();
    const projector = new LogsSearchProjector(
      {
        enabled: false,
        previewEnabled: true,
        maxFinalizedWindowsPerTick: 1,
        leaseDurationMs: 60_000,
      },
      {
        initialize,
        findInitialWatermark: vi.fn(async () => null),
        getFinalizedWatermark: vi.fn(async (watermark) => watermark),
        appendFinalizedCheckpoint: vi.fn(),
      },
      {
        acquireLease: vi.fn(async () => true),
        releaseLease: vi.fn(),
        readLeaseStatus: vi.fn(async () => null),
        initializePreviewWatermark: vi.fn(async (watermark) => watermark),
        getPreviewWatermark: vi.fn(async () => null),
        advancePreviewWatermark: vi.fn(async () => true),
      },
      projectWindow,
      () => at("2026-08-14T12:10:59.999Z")
    );

    await expect(projector.processTick()).resolves.toEqual({ finalized: 0, preview: false });
    expect(initialize).not.toHaveBeenCalled();
    expect(projectWindow).not.toHaveBeenCalled();
  });

  it("refreshes lag after a finalized projection failure", async () => {
    const now = at("2026-08-14T12:10:59.999Z");
    const watermark = at("2026-08-14T12:05:00.000Z");
    const stateStore = {
      initialize: vi.fn(async () => watermark),
      findInitialWatermark: vi.fn(async () => watermark),
      getFinalizedWatermark: vi.fn(async () => watermark),
      appendFinalizedCheckpoint: vi.fn(),
    } satisfies LogsSearchProjectorStateStore;
    const redisStore = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(),
      readLeaseStatus: vi.fn(async () => null),
      initializePreviewWatermark: vi.fn(async () => watermark),
      getPreviewWatermark: vi.fn(async () => null),
      advancePreviewWatermark: vi.fn(async () => true),
    } satisfies LogsSearchProjectorRedisStore;
    const projectionError = new Error("projection failed");
    const projector = new LogsSearchProjector(
      {
        enabled: true,
        previewEnabled: true,
        maxFinalizedWindowsPerTick: 1,
        leaseDurationMs: 60_000,
      },
      stateStore,
      redisStore,
      vi.fn(async () => {
        throw projectionError;
      }),
      () => now,
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }
    );

    await expect(projector.processTick()).rejects.toBe(projectionError);
    expect(telemetry.updateState).toHaveBeenCalledWith({
      previewLagMs: null,
      finalizedLagMs: 180_000,
    });
  });
});
