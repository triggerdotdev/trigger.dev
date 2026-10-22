import { describe, expect, it } from "vitest";
import { buildActivityTimeAxis } from "./activityTimeAxis";

const HOUR = 60 * 60 * 1000;
const start = Date.UTC(2025, 9, 4, 0, 0, 0);

describe("buildActivityTimeAxis tick labels", () => {
  it("includes the time on a 48h window so day labels do not repeat", () => {
    const data = Array.from({ length: 49 }, (_, i) => ({ bucket: start + i * HOUR }));
    const { tickFormatter } = buildActivityTimeAxis(data);
    expect(tickFormatter(start + 14 * HOUR)).toBe("Oct 4, 14:00");
    expect(tickFormatter(start + 14 * HOUR)).not.toBe(tickFormatter(start + 16 * HOUR));
  });

  it("keeps date-only labels for long ranges", () => {
    const data = Array.from({ length: 8 }, (_, i) => ({ bucket: start + i * 24 * HOUR }));
    expect(buildActivityTimeAxis(data).tickFormatter(start)).toBe("Oct 4");
  });
});
