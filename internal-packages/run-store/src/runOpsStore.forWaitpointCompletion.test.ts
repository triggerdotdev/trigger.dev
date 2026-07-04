import { describe, expect, it } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RunStore } from "./types.js";

// forWaitpointCompletion is async: it picks a preferred store from the id-shape + pins, then
// PROBES findWaitpoint to resolve where the token ACTUALLY lives (drain can relocate a cuid
// waitpoint onto NEW, or a run-ops token can be pinned LEGACY), falling back to the other store.
// So the slots here are fakes whose only behaviour is "do I hold this waitpoint id?".
function fakeStore(slot: string, heldIds: Set<string>): RunStore {
  return {
    __slot: slot,
    async findWaitpoint(args: { where?: { id?: string } }) {
      const id = args.where?.id;
      return id !== undefined && heldIds.has(id) ? ({ id } as never) : null;
    },
  } as unknown as RunStore;
}

const RUN_OPS_ID = "waitpoint_" + "a".repeat(24) + "01";
const CUID_ID = "waitpoint_" + "a".repeat(25);
const UNCLASSIFIABLE_ID = "waitpoint_" + "a".repeat(26);

// Both stores hold the id under test unless a case overrides, so the resolver returns the
// preferred store and the assertion is purely about the preference rule.
function buildRouter(opts?: { newHolds?: string[]; legacyHolds?: string[] }): {
  router: RoutingRunStore;
  newStore: RunStore;
  legacyStore: RunStore;
} {
  const all = [RUN_OPS_ID, CUID_ID, UNCLASSIFIABLE_ID];
  const newStore = fakeStore("new", new Set(opts?.newHolds ?? all));
  const legacyStore = fakeStore("legacy", new Set(opts?.legacyHolds ?? all));
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    newStore,
    legacyStore,
  };
}

describe("RoutingRunStore.forWaitpointCompletion", () => {
  it("resolves a run-ops waitpointId with no pins to the NEW slot", async () => {
    const { router, newStore } = buildRouter();
    expect(await router.forWaitpointCompletion(RUN_OPS_ID, { routeKind: "MANUAL" })).toBe(newStore);
  });

  it("resolves a cuid waitpointId with no pins to the LEGACY slot", async () => {
    const { router, legacyStore } = buildRouter();
    expect(await router.forWaitpointCompletion(CUID_ID, { routeKind: "MANUAL" })).toBe(legacyStore);
  });

  it("pins to LEGACY when isCrossTreeIdempotency is true, even for a run-ops id", async () => {
    const { router, legacyStore } = buildRouter();
    expect(
      await router.forWaitpointCompletion(RUN_OPS_ID, {
        routeKind: "IDEMPOTENCY_REUSE",
        isCrossTreeIdempotency: true,
      })
    ).toBe(legacyStore);
  });

  it("pins to LEGACY when treeOwnerResidency is LEGACY, even for a run-ops id", async () => {
    const { router, legacyStore } = buildRouter();
    expect(
      await router.forWaitpointCompletion(RUN_OPS_ID, {
        routeKind: "MANUAL",
        treeOwnerResidency: "LEGACY",
      })
    ).toBe(legacyStore);
  });

  it("pins to LEGACY when hasLegacyParent is true, even for a run-ops id", async () => {
    const { router, legacyStore } = buildRouter();
    expect(
      await router.forWaitpointCompletion(RUN_OPS_ID, {
        routeKind: "RUN",
        hasLegacyParent: true,
      })
    ).toBe(legacyStore);
  });

  it("falls back to the OTHER store when the preferred store does not hold the token", async () => {
    // run-ops id prefers NEW, but the token actually lives on LEGACY (drain/relocation): the
    // probe must fall through to LEGACY rather than route by id-shape alone and miss it.
    const { router, legacyStore } = buildRouter({ newHolds: [], legacyHolds: [RUN_OPS_ID] });
    expect(await router.forWaitpointCompletion(RUN_OPS_ID, { routeKind: "MANUAL" })).toBe(
      legacyStore
    );
  });

  it("resolves an unclassifiable id to LEGACY-preferred (never throws)", async () => {
    // #classifySafe treats an unclassifiable id as LEGACY; with both stores empty the preferred
    // (LEGACY) is returned. The completion path must not blow up on an odd-length id.
    const { router, legacyStore } = buildRouter({ newHolds: [], legacyHolds: [] });
    expect(await router.forWaitpointCompletion(UNCLASSIFIABLE_ID, { routeKind: "MANUAL" })).toBe(
      legacyStore
    );
  });
});

describe("PostgresRunStore.forWaitpointCompletion", () => {
  it("returns the same store instance without classifying, even for an unclassifiable id", async () => {
    // No prisma client touched: forWaitpointCompletion is a pure `return this`.
    const store = new PostgresRunStore({} as never);
    expect(await store.forWaitpointCompletion(UNCLASSIFIABLE_ID, { routeKind: "MANUAL" })).toBe(
      store
    );
  });
});
