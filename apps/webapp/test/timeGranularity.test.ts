import { describe, expect, it } from "vitest";
import { TimeGranularity } from "~/utils/timeGranularity";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function makeRange(durationMs: number): [Date, Date] {
  const from = new Date("2025-01-01T00:00:00Z");
  const to = new Date(from.getTime() + durationMs);
  return [from, to];
}

describe("TimeGranularity", () => {
  const granularity = new TimeGranularity([
    { max: "1h", granularity: "10s" },
    { max: "6h", granularity: "1m" },
    { max: "Infinity", granularity: "10m" },
  ]);

  it("returns the first bracket when range is within its max", () => {
    const [from, to] = makeRange(30 * MINUTE);
    expect(granularity.getTimeGranularityMs(from, to)).toBe(10 * SECOND);
  });

  it("returns a middle bracket when range exceeds the first but not the second", () => {
    const [from, to] = makeRange(2 * HOUR);
    expect(granularity.getTimeGranularityMs(from, to)).toBe(1 * MINUTE);
  });

  it("returns the last bracket when range exceeds all non-Infinity maxes", () => {
    const [from, to] = makeRange(24 * HOUR);
    expect(granularity.getTimeGranularityMs(from, to)).toBe(10 * MINUTE);
  });

  it("matches a bracket when range exactly equals its max", () => {
    const [from, to] = makeRange(1 * HOUR);
    expect(granularity.getTimeGranularityMs(from, to)).toBe(10 * SECOND);
  });

  it("moves to the next bracket when range exceeds a boundary by 1ms", () => {
    const [from, to] = makeRange(1 * HOUR + 1);
    expect(granularity.getTimeGranularityMs(from, to)).toBe(1 * MINUTE);
  });

  it("returns the first bracket's granularity for a zero-length range", () => {
    const date = new Date("2025-01-01T00:00:00Z");
    expect(granularity.getTimeGranularityMs(date, date)).toBe(10 * SECOND);
  });

  it("returns the broadest granularity for an inverted range (from > to)", () => {
    const from = new Date("2025-01-01T01:00:00Z");
    const to = new Date("2025-01-01T00:00:00Z");
    expect(granularity.getTimeGranularityMs(from, to)).toBe(10 * MINUTE);
  });

  it("throws when constructed with an empty array", () => {
    expect(() => new TimeGranularity([])).toThrow("at least one bracket");
  });
});
