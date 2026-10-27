import { describe, expect, it } from "vitest";
import { canLiveTail, hasWriteTimes } from "~/presenters/v3/liveTailGate";

describe("canLiveTail", () => {
  it("allows progressive loading with the tail on the v2 store", () => {
    expect(canLiveTail("clickhouse_v2", undefined, true)).toBe(true);
  });

  it("allows it for the v1 store while it's rerouted to v2", () => {
    expect(canLiveTail("clickhouse", undefined, true)).toBe(true);
  });

  it("falls back while the emergency span cap is set", () => {
    expect(canLiveTail("clickhouse_v2", 5_000, true)).toBe(false);
    expect(canLiveTail("clickhouse", 5_000, true)).toBe(false);
  });

  it("falls back for stores without a write time", () => {
    expect(canLiveTail("clickhouse", undefined, false)).toBe(false);
    expect(canLiveTail("taskEvent", undefined, true)).toBe(false);
  });
});

describe("hasWriteTimes", () => {
  it("is true only when every row carries a write time", () => {
    expect(hasWriteTimes([{ insertedAt: "1" }, { insertedAt: "2" }])).toBe(true);
    expect(hasWriteTimes([{ insertedAt: "1" }, {}])).toBe(false);
    expect(hasWriteTimes([])).toBe(false);
  });
});
