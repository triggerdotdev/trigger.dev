import { describe, expect, it } from "vitest";
import { generateTimeTicks } from "~/components/code/QueryResultsChart";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const min = new Date("2026-06-15T00:00:00.000Z").getTime();
const max = new Date("2026-06-22T00:00:00.000Z").getTime(); // 7 days

describe("generateTimeTicks (width-aware tick budget)", () => {
  it("produces more ticks when a wider chart allows more to fit", () => {
    const few = generateTimeTicks(min, max, 4);
    const many = generateTimeTicks(min, max, 16);
    expect(many.length).toBeGreaterThan(few.length);
  });

  it("stays near the budget for a narrow chart", () => {
    // The loop targets <= maxTicks; edge ticks can add 1-2.
    expect(generateTimeTicks(min, max, 4).length).toBeLessThanOrEqual(6);
  });

  it("keeps every tick within the range (plus a small edge margin)", () => {
    for (const t of generateTimeTicks(min, max, 12)) {
      expect(t).toBeGreaterThanOrEqual(min - DAY);
      expect(t).toBeLessThanOrEqual(max + DAY);
    }
  });

  it("ticks are sorted ascending", () => {
    const ticks = generateTimeTicks(min, max, 12);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });

  it("returns a single tick for a zero range", () => {
    expect(generateTimeTicks(min, min, 8)).toEqual([min]);
  });
});
