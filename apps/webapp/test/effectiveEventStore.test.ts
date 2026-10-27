import { describe, expect, it } from "vitest";
import { effectiveEventStore } from "~/v3/eventRepository/effectiveEventStore";

describe("effectiveEventStore", () => {
  it("routes the v1 store to v2 when the reroute is on", () => {
    expect(effectiveEventStore("clickhouse", true)).toBe("clickhouse_v2");
  });

  it("keeps the v1 store when the reroute is off", () => {
    expect(effectiveEventStore("clickhouse", false)).toBe("clickhouse");
  });

  it("leaves every other store unchanged", () => {
    for (const store of ["clickhouse_v2", "postgres", "taskEvent", "taskEventPartitioned"]) {
      expect(effectiveEventStore(store, true)).toBe(store);
      expect(effectiveEventStore(store, false)).toBe(store);
    }
  });
});
