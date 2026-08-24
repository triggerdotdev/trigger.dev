import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import type { ReadClient, RunStore } from "./types.js";

// Pins the routing ALGEBRA: probe order, merge precedence, and the two id-less fallbacks that
// differ by role. No DB — each slot is a fake RunStore recording into ONE shared ordered log, so a
// sequential probe's leg order and a merge's winner are both observable. Real two-DB topology stays
// with the heteroRunOpsPostgresTest suites.
//
// MUST NOT assert invocation order for a PARALLEL fan-out: both legs are issued before either
// resolves, so the order they are created in is not a behaviour.

type Slot = "new" | "legacy";

type Call = { slot: Slot; method: string };

type FakeConfig = {
  // Rows this store returns from findRun / findRuns / findRunOrThrow, regardless of filter.
  runs?: Array<Record<string, unknown>>;
  // Edge rows this store returns from findManyTaskRunWaitpoints, regardless of filter.
  edges?: Array<Record<string, unknown>>;
  // Waitpoint rows this store returns from findWaitpoint, regardless of filter.
  waitpoint?: Record<string, unknown> | null;
};

type FakeStore = RunStore & {
  slot: Slot;
  primaryReadClient: { __primary: Slot };
};

function fakeStore(slot: Slot, log: Call[], config: FakeConfig = {}): FakeStore {
  const record = (method: string) => log.push({ slot, method });
  const runs = config.runs ?? [];

  const store: Partial<FakeStore> = {
    slot,
    primaryReadClient: { __primary: slot },

    findRun: ((_where: unknown, _args?: unknown) => {
      record("findRun");
      return Promise.resolve((runs[0] ?? null) as never);
    }) as FakeStore["findRun"],

    findRunOnPrimary: ((_where: unknown, _args?: unknown) => {
      record("findRunOnPrimary");
      return Promise.resolve((runs[0] ?? null) as never);
    }) as FakeStore["findRunOnPrimary"],

    findRunOrThrow: ((_where: unknown, _args?: unknown) => {
      record("findRunOrThrow");
      if (runs[0] === undefined) {
        return Promise.reject(new Error(`no run on ${slot}`)) as never;
      }
      return Promise.resolve(runs[0] as never);
    }) as FakeStore["findRunOrThrow"],

    findRuns: ((_args: unknown, _client?: ReadClient) => {
      record("findRuns");
      return Promise.resolve(runs as never);
    }) as FakeStore["findRuns"],

    createRun: ((_params: unknown) => {
      record("createRun");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["createRun"],

    createTaskRunCheckpoint: ((_args: unknown) => {
      record("createTaskRunCheckpoint");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["createTaskRunCheckpoint"],

    findWaitpoint: ((_args: unknown, _client?: ReadClient) => {
      record("findWaitpoint");
      return Promise.resolve((config.waitpoint ?? null) as never);
    }) as FakeStore["findWaitpoint"],

    updateWaitpoint: ((_args: unknown) => {
      record("updateWaitpoint");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["updateWaitpoint"],

    findManyTaskRunWaitpoints: ((_args: unknown, _client?: ReadClient) => {
      record("findManyTaskRunWaitpoints");
      return Promise.resolve((config.edges ?? []) as never);
    }) as FakeStore["findManyTaskRunWaitpoints"],
  };

  return store as unknown as FakeStore;
}

// Deterministic residency by id prefix via the classify seam (no dependence on id-shape rules).
function buildRouter(newConfig: FakeConfig = {}, legacyConfig: FakeConfig = {}) {
  const log: Call[] = [];
  const newStore = fakeStore("new", log, newConfig);
  const legacyStore = fakeStore("legacy", log, legacyConfig);
  const router = new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    classify: (id: string) => (id.startsWith("new") ? "NEW" : "LEGACY"),
  });
  return { router, newStore, legacyStore, log };
}

const trace = (log: Call[]) => log.map((c) => `${c.slot}:${c.method}`);

describe("RoutingRunStore #probeOrder — new then legacy, sequential", () => {
  it("probes new BEFORE legacy for an unrouted findRun", async () => {
    const { router, log } = buildRouter();
    await router.findRun({ spanId: "span_x" });
    expect(trace(log)).toEqual(["new:findRun", "legacy:findRun"]);
  });

  it("stops at the first non-null leg and never consults legacy", async () => {
    const { router, log } = buildRouter({ runs: [{ id: "r1" }] });
    await router.findRun({ spanId: "span_x" });
    expect(trace(log)).toEqual(["new:findRun"]);
  });

  it("gives the LAST probe leg the canonical not-found throw", async () => {
    const { router, log } = buildRouter();
    await expect(router.findRunOrThrow({ spanId: "span_x" })).rejects.toThrow("no run on legacy");
    // new is probed with the nullable read; only legacy is asked to throw.
    expect(trace(log)).toEqual(["new:findRun", "legacy:findRunOrThrow"]);
  });

  it("probes each store's own primary for a read-your-writes unrouted findRun", async () => {
    const { router, log } = buildRouter();
    await router.findRunOnPrimary({ spanId: "span_x" });
    expect(trace(log)).toEqual(["new:findRunOnPrimary", "legacy:findRunOnPrimary"]);
  });
});

describe("RoutingRunStore #precedence — NEW wins a merge", () => {
  it("keeps the NEW row for a duplicate run id on an open predicate", async () => {
    const { router } = buildRouter(
      { runs: [{ id: "dup", from: "new" }] },
      { runs: [{ id: "dup", from: "legacy" }] }
    );
    const rows = (await router.findRuns({
      where: { runtimeEnvironmentId: "env_1" },
      select: { id: true, from: true },
    })) as Array<{ id: string; from: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from).toBe("new");
  });

  // Every merge in the router MUST resolve a duplicate id NEW-wins, edges included.
  it("keeps the NEW row for a duplicate edge id on a waitpoint-keyed edge read", async () => {
    const { router } = buildRouter(
      { edges: [{ id: "edge_dup", taskRunId: "new_run" }] },
      { edges: [{ id: "edge_dup", taskRunId: "legacy_run" }] }
    );
    const edges = (await router.findManyTaskRunWaitpoints({
      where: { waitpointId: "waitpoint_x" },
      select: { id: true, taskRunId: true },
    })) as Array<{ id: string; taskRunId: string }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]?.taskRunId).toBe("new_run");
  });
});

describe("RoutingRunStore id-less fallbacks — the two defaults differ by role", () => {
  it("routes an id-less create to new (#idlessRouteShard)", async () => {
    const { router, log } = buildRouter();
    await router.createRun({ data: {} } as never);
    expect(trace(log)).toEqual(["new:createRun"]);
  });

  it("routes an id-less checkpoint create to new (#idlessRouteShard)", async () => {
    const { router, log } = buildRouter();
    await router.createTaskRunCheckpoint({ data: {} } as never);
    expect(trace(log)).toEqual(["new:createTaskRunCheckpoint"]);
  });

  it("routes an id-less waitpoint update to legacy (#idlessWaitpointShard)", async () => {
    const { router, log } = buildRouter();
    await router.updateWaitpoint({ where: { idempotencyKey: "k" }, data: {} } as never);
    expect(trace(log)).toEqual(["legacy:updateWaitpoint"]);
  });
});
