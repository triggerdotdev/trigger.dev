import { describe, expect, it } from "vitest";
import {
  createSnapshotStoreOrgCensus,
  type SnapshotStoreOrgCensusClient,
} from "~/v3/snapshotStoreOrgCensus.server";

type Row = { id: string; featureFlags: unknown };

function fakeClient(rows: Row[]): SnapshotStoreOrgCensusClient {
  return {
    organization: {
      findMany: async () => rows,
    },
  };
}

function build(rows: Row[]) {
  return createSnapshotStoreOrgCensus({ replica: fakeClient(rows) }, { autoStart: false });
}

describe("snapshot store org census", () => {
  it("reflects a loaded set of overrides", async () => {
    const census = build([
      { id: "org_a", featureFlags: { snapshotStoreOrgMode: "redis-read" } },
      { id: "org_b", featureFlags: { snapshotStoreOrgMode: "dual-write" } },
      { id: "org_c", featureFlags: { snapshotStoreOrgMode: "redis-only" } },
    ]);

    await census.refresh();

    expect(census.anyOrgReadEnabled()).toBe(true);
    expect(census.anyOrgRedisOnly()).toBe(true);
    expect(census.isCohortMember("org_a")).toBe(true);
    expect(census.isCohortMember("org_b")).toBe(true);
    expect(census.isCohortMember("org_c")).toBe(true);
    expect(census.isCohortMember("org_d")).toBe(false);
  });

  it("reports an empty census once loaded with no active override", async () => {
    const census = build([
      { id: "org_a", featureFlags: { snapshotStoreOrgMode: "off" } },
      { id: "org_b", featureFlags: null },
    ]);

    await census.refresh();

    expect(census.anyOrgReadEnabled()).toBe(false);
    expect(census.anyOrgRedisOnly()).toBe(false);
    expect(census.isCohortMember("org_a")).toBe(false);
    expect(census.isCohortMember("org_b")).toBe(false);
  });

  it("errs toward routing before the first successful load (cold)", () => {
    const census = build([{ id: "org_a", featureFlags: { snapshotStoreOrgMode: "redis-only" } }]);

    // Deliberately NOT refreshed: this is the cold window.
    expect(census.anyOrgReadEnabled()).toBe(true);
    expect(census.anyOrgRedisOnly()).toBe(false);
    expect(census.isCohortMember("org_a")).toBe(false);
  });

  it("keeps the last-good snapshot when a later load fails", async () => {
    let calls = 0;
    const client: SnapshotStoreOrgCensusClient = {
      organization: {
        findMany: async () => {
          calls += 1;
          if (calls === 1) {
            return [{ id: "org_a", featureFlags: { snapshotStoreOrgMode: "redis-only" } }];
          }
          throw new Error("control plane unreachable");
        },
      },
    };
    const census = createSnapshotStoreOrgCensus({ replica: client }, { autoStart: false });

    await census.refresh();
    expect(census.anyOrgReadEnabled()).toBe(true);
    expect(census.anyOrgRedisOnly()).toBe(true);
    expect(census.isCohortMember("org_a")).toBe(true);

    // A failing reload must not throw and must not revert to cold defaults.
    await expect(census.refresh()).resolves.toBeUndefined();
    expect(census.anyOrgReadEnabled()).toBe(true);
    expect(census.anyOrgRedisOnly()).toBe(true);
    expect(census.isCohortMember("org_a")).toBe(true);
  });
});
