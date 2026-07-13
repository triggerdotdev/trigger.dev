import { describe, expect, it } from "vitest";
import { computeZoomRange } from "~/components/primitives/charts/ChartSyncContext";

describe("computeZoomRange", () => {
  it("orders the selection ascending regardless of drag direction", () => {
    expect(computeZoomRange(300, 100)).toEqual({ start: 100, end: 300 });
    expect(computeZoomRange(100, 300)).toEqual({ start: 100, end: 300 });
  });

  it("adds the bucket width so the last selected bucket is included", () => {
    expect(computeZoomRange(100, 300, 60)).toEqual({ start: 100, end: 360 });
  });

  it("returns null for a non-drag (start === current)", () => {
    expect(computeZoomRange(100, 100)).toBeNull();
    expect(computeZoomRange(100, 100, 60)).toBeNull();
  });

  it("returns null for non-numeric selections", () => {
    expect(computeZoomRange("a", "b")).toBeNull();
  });

  it("handles numeric-string category values from recharts", () => {
    expect(computeZoomRange("100", "300", 60)).toEqual({ start: 100, end: 360 });
  });
});
