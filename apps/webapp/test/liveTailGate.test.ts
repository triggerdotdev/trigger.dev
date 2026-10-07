import { describe, expect, it } from "vitest";
import { canLiveTail, hasWriteTimes } from "~/presenters/v3/liveTailGate";

describe("canLiveTail", () => {
  it("allows progressive loading with the tail on the v2 store", () => {
    expect(canLiveTail("clickhouse_v2", undefined)).toBe(true);
  });

  it("falls back while the emergency span cap is set", () => {
    expect(canLiveTail("clickhouse_v2", 5_000)).toBe(false);
  });

  it("falls back for stores without a write time", () => {
    expect(canLiveTail("clickhouse", undefined)).toBe(false);
    expect(canLiveTail("taskEvent", undefined)).toBe(false);
  });
});

describe("hasWriteTimes", () => {
  it("is true only when every row carries a write time", () => {
    expect(hasWriteTimes([{ insertedAt: "1" }, { insertedAt: "2" }])).toBe(true);
    expect(hasWriteTimes([{ insertedAt: "1" }, {}])).toBe(false);
    expect(hasWriteTimes([])).toBe(false);
  });
});
