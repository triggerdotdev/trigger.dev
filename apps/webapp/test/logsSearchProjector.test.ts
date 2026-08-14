import { describe, expect, it } from "vitest";
import {
  calculateClosedWindowBoundary,
  LOGS_SEARCH_PROJECTOR_STATE_ID,
  selectNextProjectionWindow,
  type LogsSearchProjectorState,
} from "~/services/logsSearchProjector.server";

const minute = 60_000;
const at = (value: string) => new Date(value);

function state(overrides: Partial<LogsSearchProjectorState> = {}): LogsSearchProjectorState {
  const boundary = overrides.liveWatermark ?? at("2026-08-14T12:05:00.000Z");
  return {
    id: LOGS_SEARCH_PROJECTOR_STATE_ID,
    liveWatermark: boundary,
    historicalWatermark: overrides.historicalWatermark ?? boundary,
    backfillTarget: overrides.backfillTarget ?? null,
    paused: overrides.paused ?? false,
    leaseToken: overrides.leaseToken ?? null,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
  };
}

describe("logs search projector window selection", () => {
  it("floors the safe cutoff to a closed minute", () => {
    expect(
      calculateClosedWindowBoundary(at("2026-08-14T12:10:59.999Z"), 2 * minute).toISOString()
    ).toBe("2026-08-14T12:08:00.000Z");
  });

  it("selects the oldest live window before historical work", () => {
    expect(
      selectNextProjectionWindow(
        state({
          liveWatermark: at("2026-08-14T12:05:00.000Z"),
          historicalWatermark: at("2026-08-14T12:04:00.000Z"),
          backfillTarget: at("2026-08-14T12:02:00.000Z"),
        }),
        at("2026-08-14T12:08:00.000Z")
      )
    ).toEqual({
      mode: "live",
      start: at("2026-08-14T12:05:00.000Z"),
      end: at("2026-08-14T12:06:00.000Z"),
    });
  });

  it("extends historical coverage backwards after live work catches up", () => {
    expect(
      selectNextProjectionWindow(
        state({
          liveWatermark: at("2026-08-14T12:08:00.000Z"),
          historicalWatermark: at("2026-08-14T12:04:00.000Z"),
          backfillTarget: at("2026-08-14T12:02:00.000Z"),
        }),
        at("2026-08-14T12:08:00.000Z")
      )
    ).toEqual({
      mode: "backfill",
      start: at("2026-08-14T12:03:00.000Z"),
      end: at("2026-08-14T12:04:00.000Z"),
    });
  });

  it("selects no work while paused or fully caught up", () => {
    const safeCutoff = at("2026-08-14T12:08:00.000Z");
    expect(
      selectNextProjectionWindow(
        state({ liveWatermark: safeCutoff, historicalWatermark: safeCutoff }),
        safeCutoff
      )
    ).toBeNull();
    expect(
      selectNextProjectionWindow(
        state({ liveWatermark: at("2026-08-14T12:05:00.000Z"), paused: true }),
        safeCutoff
      )
    ).toBeNull();
  });
});
