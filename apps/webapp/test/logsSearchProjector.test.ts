import { describe, expect, it, vi } from "vitest";
import {
  calculateClosedWindowBoundary,
  LogsSearchProjector,
  LogsSearchProjectorConflictError,
  LogsSearchProjectorValidationError,
  type LogsSearchProjectorState,
  type LogsSearchProjectorStateStore,
  type LogsSearchProjectorWindow,
} from "~/services/logsSearchProjector.server";

const minute = 60_000;
const at = (value: string) => new Date(value);

class FakeStateStore implements LogsSearchProjectorStateStore {
  state?: LogsSearchProjectorState;

  constructor(state?: Partial<LogsSearchProjectorState>) {
    if (state) {
      const boundary = state.liveWatermark ?? at("2026-08-14T12:00:00.000Z");
      this.state = {
        id: "task_events_search_v2",
        liveWatermark: boundary,
        historicalWatermark: state.historicalWatermark ?? boundary,
        backfillTarget: state.backfillTarget ?? null,
        paused: state.paused ?? false,
        leaseToken: state.leaseToken ?? null,
        leaseExpiresAt: state.leaseExpiresAt ?? null,
      };
    }
  }

  async initialize(boundary: Date) {
    this.state ??= {
      id: "task_events_search_v2",
      liveWatermark: boundary,
      historicalWatermark: boundary,
      backfillTarget: null,
      paused: false,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    return this.get();
  }

  async find() {
    return this.state ? { ...this.state } : null;
  }

  async get() {
    if (!this.state) throw new Error("not initialized");
    return { ...this.state };
  }

  async acquireLease(token: string, leaseDurationMs: number) {
    if (
      !this.state ||
      this.state.paused ||
      (this.state.leaseToken && this.state.leaseExpiresAt && this.state.leaseExpiresAt > new Date())
    ) {
      return false;
    }
    this.state.leaseToken = token;
    this.state.leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    return true;
  }

  async renewLease(token: string, leaseDurationMs: number) {
    if (!this.state || this.state.paused || this.state.leaseToken !== token) return false;
    this.state.leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    return true;
  }

  async releaseLease(token: string) {
    if (this.state?.leaseToken === token) {
      this.state.leaseToken = null;
      this.state.leaseExpiresAt = null;
    }
  }

  async advanceLive(token: string, expected: Date, next: Date) {
    if (
      !this.state ||
      this.state.paused ||
      this.state.leaseToken !== token ||
      this.state.liveWatermark.getTime() !== expected.getTime()
    ) {
      return false;
    }
    this.state.liveWatermark = next;
    return true;
  }

  async advanceHistorical(token: string, expected: Date, next: Date, expectedTarget: Date) {
    if (
      !this.state ||
      this.state.paused ||
      this.state.leaseToken !== token ||
      this.state.historicalWatermark.getTime() !== expected.getTime() ||
      this.state.backfillTarget?.getTime() !== expectedTarget.getTime()
    ) {
      return false;
    }
    this.state.historicalWatermark = next;
    if (next.getTime() === expectedTarget.getTime()) this.state.backfillTarget = null;
    return true;
  }

  async pause() {
    if (!this.state) throw new Error("not initialized");
    this.state.paused = true;
  }

  async resume() {
    if (!this.state) throw new Error("not initialized");
    this.state.paused = false;
  }

  async setBackfillTarget(expectedHistorical: Date, target: Date) {
    if (
      !this.state ||
      this.state.backfillTarget ||
      this.state.historicalWatermark.getTime() !== expectedHistorical.getTime()
    ) {
      return false;
    }
    this.state.backfillTarget = target;
    return true;
  }

  async cancelBackfill() {
    if (!this.state) throw new Error("not initialized");
    this.state.backfillTarget = null;
  }
}

function projector(
  store: FakeStateStore,
  projectWindow: (window: LogsSearchProjectorWindow) => Promise<{
    queryId: string;
    readRows: number;
    writtenRows: number;
  }>,
  options: { maxWindowsPerTick?: number; now?: Date; clock?: () => Date | Promise<Date> } = {}
) {
  const now = options.now ?? at("2026-08-14T12:10:30.000Z");
  return new LogsSearchProjector(
    {
      safetyDelayMs: 2 * minute,
      maxWindowsPerTick: options.maxWindowsPerTick ?? 5,
      leaseDurationMs: 3 * minute,
      backfillEnabled: true,
      maxBackfillRangeMs: 7 * 24 * 60 * minute,
      maxBackfillAgeMs: 90 * 24 * 60 * minute,
    },
    store,
    projectWindow,
    options.clock ?? (() => now),
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  );
}

const success = async () => ({ queryId: "query", readRows: 10, writtenRows: 3 });

describe("LogsSearchProjector", () => {
  it("floors the safe cutoff to a closed minute", () => {
    expect(
      calculateClosedWindowBoundary(at("2026-08-14T12:10:59.999Z"), 2 * minute).toISOString()
    ).toBe("2026-08-14T12:08:00.000Z");
  });

  it("reports uninitialized status without anchoring the watermark", async () => {
    const store = new FakeStateStore();
    const service = projector(store, success);

    await expect(service.status()).resolves.toMatchObject({ initialized: false });
    expect(store.state).toBeUndefined();
  });

  it("pauses without depending on ClickHouse", async () => {
    const store = new FakeStateStore({ liveWatermark: at("2026-08-14T12:05:00.000Z") });
    const service = projector(store, success, {
      clock: async () => {
        throw new Error("ClickHouse unavailable");
      },
    });

    await expect(service.pause()).resolves.toMatchObject({
      initialized: true,
      paused: true,
      safeCutoff: null,
    });
  });

  it("processes missed live windows oldest first and respects the tick cap", async () => {
    const store = new FakeStateStore({ liveWatermark: at("2026-08-14T12:05:00.000Z") });
    const windows: LogsSearchProjectorWindow[] = [];
    const service = projector(
      store,
      async (window) => {
        windows.push(window);
        return success();
      },
      { maxWindowsPerTick: 2 }
    );

    await expect(service.processTick()).resolves.toEqual({ processed: 2, leaseAcquired: true });
    expect(windows.map((window) => window.start.toISOString())).toEqual([
      "2026-08-14T12:05:00.000Z",
      "2026-08-14T12:06:00.000Z",
    ]);
    expect(store.state?.liveWatermark.toISOString()).toBe("2026-08-14T12:07:00.000Z");
  });

  it("does not advance after a projection failure", async () => {
    const store = new FakeStateStore({ liveWatermark: at("2026-08-14T12:07:00.000Z") });
    const service = projector(store, async () => {
      throw new Error("clickhouse failed");
    });

    await expect(service.processTick()).rejects.toThrow("clickhouse failed");
    expect(store.state?.liveWatermark.toISOString()).toBe("2026-08-14T12:07:00.000Z");
    expect(store.state?.leaseToken).toBeNull();
  });

  it("stops without advancing when pause wins the watermark race", async () => {
    const store = new FakeStateStore({ liveWatermark: at("2026-08-14T12:07:00.000Z") });
    const service = projector(store, async () => {
      await store.pause();
      return success();
    });

    await expect(service.processTick()).resolves.toEqual({ processed: 0, leaseAcquired: true });
    expect(store.state?.liveWatermark.toISOString()).toBe("2026-08-14T12:07:00.000Z");
    expect(store.state?.paused).toBe(true);
  });

  it("does not process when another lease is active", async () => {
    const store = new FakeStateStore({
      liveWatermark: at("2026-08-14T12:07:00.000Z"),
      leaseToken: "other",
      leaseExpiresAt: at("2026-08-14T12:20:00.000Z"),
    });
    const project = vi.fn(success);
    const service = projector(store, project);

    await expect(service.processTick()).resolves.toEqual({ processed: 0, leaseAcquired: false });
    expect(project).not.toHaveBeenCalled();
  });

  it("prioritizes live work and then extends historical coverage backwards", async () => {
    const store = new FakeStateStore({
      liveWatermark: at("2026-08-14T12:07:00.000Z"),
      historicalWatermark: at("2026-08-14T12:05:00.000Z"),
      backfillTarget: at("2026-08-14T12:03:00.000Z"),
    });
    const modes: string[] = [];
    const service = projector(store, async (window) => {
      modes.push(window.mode);
      return success();
    });

    await service.processTick();
    expect(modes).toEqual(["live", "backfill", "backfill"]);
    expect(store.state?.liveWatermark.toISOString()).toBe("2026-08-14T12:08:00.000Z");
    expect(store.state?.historicalWatermark.toISOString()).toBe("2026-08-14T12:03:00.000Z");
    expect(store.state?.backfillTarget).toBeNull();
  });

  it("requires a bounded contiguous backfill", async () => {
    const store = new FakeStateStore({
      liveWatermark: at("2026-08-14T12:08:00.000Z"),
      historicalWatermark: at("2026-08-14T12:05:00.000Z"),
    });
    const service = projector(store, success);

    await expect(
      service.startBackfill({
        from: at("2026-08-14T12:03:00.000Z"),
        to: at("2026-08-14T12:04:00.000Z"),
      })
    ).rejects.toBeInstanceOf(LogsSearchProjectorConflictError);

    await expect(
      service.startBackfill({
        from: at("2026-08-14T12:03:00.001Z"),
        to: at("2026-08-14T12:05:00.000Z"),
      })
    ).rejects.toBeInstanceOf(LogsSearchProjectorValidationError);

    const status = await service.startBackfill({
      from: at("2026-08-14T12:03:00.000Z"),
      to: at("2026-08-14T12:05:00.000Z"),
    });
    expect(status.backfillWindowsRemaining).toBe(2);
  });
});
