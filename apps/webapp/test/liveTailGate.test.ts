import { describe, expect, it } from "vitest";
import { canLiveTail, hasWriteTimes } from "~/presenters/v3/liveTailGate";

describe("canLiveTail", () => {
  it("allows progressive loading with the tail on the v2 store when the switch is on", () => {
    expect(canLiveTail("1", "clickhouse_v2")).toBe(true);
  });

  it("falls back when the env switch is off or unset", () => {
    expect(canLiveTail("0", "clickhouse_v2")).toBe(false);
    expect(canLiveTail("", "clickhouse_v2")).toBe(false);
  });

  it("falls back for stores without a write time", () => {
    expect(canLiveTail("1", "clickhouse")).toBe(false);
    expect(canLiveTail("1", "taskEvent")).toBe(false);
  });
});

describe("hasWriteTimes", () => {
  it("is true only when every row carries a write time", () => {
    expect(hasWriteTimes([{ insertedAt: "1" }, { insertedAt: "2" }])).toBe(true);
    expect(hasWriteTimes([{ insertedAt: "1" }, {}])).toBe(false);
    expect(hasWriteTimes([])).toBe(false);
  });
});
