import { describe, expect, it } from "vitest";
import {
  effectiveEventStore,
  legacyEventStoreWarning,
} from "~/v3/eventRepository/effectiveEventStore";

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

describe("legacyEventStoreWarning", () => {
  it("tells instances on the retired store to switch to clickhouse_v2", () => {
    const warning = legacyEventStoreWarning("clickhouse", true);

    expect(warning).toContain("EVENT_REPOSITORY_DEFAULT_STORE=clickhouse_v2");
    expect(warning).toContain("#move-from-the-legacy-clickhouse-store");
  });

  it("flags the reroute escape hatch as temporary", () => {
    const warning = legacyEventStoreWarning("clickhouse", false);

    expect(warning).toContain("EVENT_REPOSITORY_V1_REROUTE_ENABLED=0");
    expect(warning).toContain("temporary");
  });

  it("stays quiet for every other store", () => {
    for (const store of ["clickhouse_v2", "postgres"]) {
      expect(legacyEventStoreWarning(store, true)).toBeUndefined();
      expect(legacyEventStoreWarning(store, false)).toBeUndefined();
    }
  });
});
