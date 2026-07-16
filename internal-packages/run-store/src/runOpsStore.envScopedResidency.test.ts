import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RunStore } from "./types.js";

// Env-scoped writes with no owning run (waitpoint tags; idempotency-key reset by predicate) must
// route to NEW when the env mints run-ops ids, instead of defaulting to LEGACY / fanning a wrong-DB
// write. Pure routing: fake RunStore slots record which store the router dispatches to.

type Call = { method: string; args: unknown[] };
type FakeStore = RunStore & { slot: "new" | "legacy"; calls: Call[] };

function fakeStore(slot: "new" | "legacy"): FakeStore {
  const calls: Call[] = [];
  const rec =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    slot,
    calls,
    upsertWaitpointTag: rec("upsertWaitpointTag", { id: slot, slot }),
    clearIdempotencyKey: rec("clearIdempotencyKey", { count: slot === "new" ? 1 : 0 }),
  } as unknown as FakeStore;
}

function buildRouter() {
  const newStore = fakeStore("new");
  const legacyStore = fakeStore("legacy");
  const router = new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    classify: (id: string) => (id.startsWith("new") ? "NEW" : "LEGACY"),
  });
  return { router, newStore, legacyStore };
}

describe("RoutingRunStore.upsertWaitpointTag — residency hint for a tag with no minted id", () => {
  it("routes to NEW when residency is NEW and no id is supplied", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.upsertWaitpointTag({ environmentId: "env", name: "t", projectId: "p" }, undefined, "NEW");
    expect(newStore.calls.map((c) => c.method)).toEqual(["upsertWaitpointTag"]);
    expect(legacyStore.calls).toHaveLength(0);
  });

  it("still falls back to LEGACY when no id and no residency are supplied", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.upsertWaitpointTag({ environmentId: "env", name: "t", projectId: "p" });
    expect(legacyStore.calls.map((c) => c.method)).toEqual(["upsertWaitpointTag"]);
    expect(newStore.calls).toHaveLength(0);
  });
});

describe("RoutingRunStore.clearIdempotencyKey — predicate routes NEW when the env mints new", () => {
  it("routes a byPredicate reset to NEW only when residency is NEW (no legacy fan-out)", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    const result = await router.clearIdempotencyKey({
      byPredicate: {
        idempotencyKey: "k",
        taskIdentifier: "task",
        runtimeEnvironmentId: "env",
        residency: "NEW",
      },
    });
    expect(newStore.calls.map((c) => c.method)).toEqual(["clearIdempotencyKey"]);
    expect(legacyStore.calls).toHaveLength(0);
    expect(result.count).toBe(1);
  });

  it("still fans out a byPredicate reset with no residency (mixed residency)", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.clearIdempotencyKey({
      byPredicate: { idempotencyKey: "k", taskIdentifier: "task", runtimeEnvironmentId: "env" },
    });
    expect(newStore.calls).toHaveLength(1);
    expect(legacyStore.calls).toHaveLength(1);
  });

  it("routes byId to the owning store (unchanged)", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.clearIdempotencyKey({ byId: { runId: "new_run", idempotencyKey: "k" } });
    expect(newStore.calls.map((c) => c.method)).toEqual(["clearIdempotencyKey"]);
    expect(legacyStore.calls).toHaveLength(0);
  });
});
