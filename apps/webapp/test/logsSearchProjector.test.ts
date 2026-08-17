import { describe, expect, it } from "vitest";
import {
  finalizedSafeCutoff,
  previewSafeCutoff,
  selectFinalizedWindow,
  selectPreviewWindow,
} from "~/services/logsSearchProjector.server";

const at = (value: string) => new Date(value);

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
