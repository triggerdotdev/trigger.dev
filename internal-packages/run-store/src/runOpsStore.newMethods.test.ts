import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import type { FinalizeRunData, RunStore } from "./types.js";

// Pure routing unit tests for the five store methods added in Track 1. No DB: each slot is a fake
// RunStore that records the calls it receives, so the assertions are purely about WHICH store the
// router dispatches to (by residency key) and WHAT it forwards (never a control-plane tx into a
// routed write; caller client presence escalates to the owning store's own primary).

type Call = { method: string; args: unknown[] };

type FakeStore = RunStore & {
  slot: "new" | "legacy";
  calls: Call[];
  primaryReadClient: { __primary: "new" | "legacy" };
};

function fakeStore(slot: "new" | "legacy"): FakeStore {
  const calls: Call[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    slot,
    calls,
    primaryReadClient: { __primary: slot },
    finalizeRun: record("finalizeRun", { slot, kind: "run" }),
    findManyBatchTaskRunItems: record("findManyBatchTaskRunItems", [{ slot }]),
    findBatchTaskRunItem: record("findBatchTaskRunItem", { slot }),
    upsertWaitpointTag: record("upsertWaitpointTag", { slot }),
    // Slot-specific rows so the merge/dedupe (NEW-wins) is observable; id "a" collides across legs.
    findManyWaitpointTags: record(
      "findManyWaitpointTags",
      slot === "new"
        ? [
            { id: "b", src: "new" },
            { id: "a", src: "new" },
          ]
        : [
            { id: "c", src: "legacy" },
            { id: "a", src: "legacy" },
          ]
    ),
  } as unknown as FakeStore;
}

// Deterministic residency by id prefix, injected via the classify seam so the tests don't depend on
// id-shape length rules.
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

const DATA: FinalizeRunData = { status: "COMPLETED_SUCCESSFULLY", completedAt: new Date() };

describe("RoutingRunStore.finalizeRun", () => {
  it("routes by runId and forwards the projection, never the tx", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    const projection = { select: { id: true } };
    await router.finalizeRun("new_run", DATA, projection);
    expect(newStore.calls).toHaveLength(1);
    expect(newStore.calls[0]?.args).toEqual(["new_run", DATA, projection]);
    expect(legacyStore.calls).toHaveLength(0);
  });

  it("routes a cuid/legacy runId to the legacy store", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.finalizeRun("legacy_run", DATA, { include: { attempts: true } });
    expect(legacyStore.calls[0]?.args).toEqual([
      "legacy_run",
      DATA,
      { include: { attempts: true } },
    ]);
    expect(newStore.calls).toHaveLength(0);
  });

  it("drops a caller-passed control-plane tx (never threaded into the routed write)", async () => {
    const { router, legacyStore } = buildRouter();
    const controlPlaneTx = { $fake: "cp-tx" };
    await router.finalizeRun("legacy_run", DATA, controlPlaneTx as never);
    // The tx is neither a select/include projection nor forwarded: the sub-store sees a 3-arg call
    // whose projection slot is undefined.
    expect(legacyStore.calls[0]?.args).toEqual(["legacy_run", DATA, undefined]);
  });
});

describe("RoutingRunStore.findManyBatchTaskRunItems", () => {
  it("routes by batchTaskRunId first", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.findManyBatchTaskRunItems({
      batchTaskRunId: "new_batch",
      taskRunId: "legacy_run",
    });
    expect(newStore.calls[0]?.method).toBe("findManyBatchTaskRunItems");
    expect(legacyStore.calls).toHaveLength(0);
  });

  it("falls back to taskRunId when no batchTaskRunId is present", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.findManyBatchTaskRunItems({ taskRunId: "legacy_run" });
    expect(legacyStore.calls[0]?.method).toBe("findManyBatchTaskRunItems");
    expect(newStore.calls).toHaveLength(0);
  });

  it("escalates a caller client to the owning store's own primary (read-your-writes)", async () => {
    const { router, newStore } = buildRouter();
    // A non-replica client object signals read-your-writes; it must NOT be forwarded verbatim.
    await router.findManyBatchTaskRunItems({ batchTaskRunId: "new_batch" }, undefined, {
      writer: true,
    } as never);
    expect(newStore.calls[0]?.args[2]).toEqual({ __primary: "new" });
  });
});

describe("RoutingRunStore.findBatchTaskRunItem", () => {
  it("routes by batchTaskRunId", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.findBatchTaskRunItem({ batchTaskRunId: "legacy_batch", taskRunId: "new_run" });
    expect(legacyStore.calls[0]?.method).toBe("findBatchTaskRunItem");
    expect(newStore.calls).toHaveLength(0);
  });
});

describe("RoutingRunStore.upsertWaitpointTag", () => {
  it("routes the write by the tag's minted id-shape (env mint-kind)", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.upsertWaitpointTag({
      environmentId: "env",
      name: "t",
      projectId: "p",
      id: "new_tag",
    });
    expect(newStore.calls[0]?.method).toBe("upsertWaitpointTag");
    expect(legacyStore.calls).toHaveLength(0);
  });

  it("falls back to legacy when no minted id is supplied", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    await router.upsertWaitpointTag({ environmentId: "env", name: "t", projectId: "p" });
    expect(legacyStore.calls[0]?.method).toBe("upsertWaitpointTag");
    expect(newStore.calls).toHaveLength(0);
  });

  it("never threads a control-plane tx into either leg", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    const tx = { $fake: "cp-tx" };
    await router.upsertWaitpointTag(
      { environmentId: "env", name: "t", projectId: "p", id: "legacy_tag" },
      tx as never
    );
    // The routed write runs on the owning store's own client, so the tx is dropped on the LEGACY leg too.
    expect(legacyStore.calls[0]?.args[1]).toBeUndefined();

    const tx2 = { $fake: "cp-tx-2" };
    await router.upsertWaitpointTag(
      { environmentId: "env", name: "t", projectId: "p", id: "new_tag" },
      tx2 as never
    );
    // NEW leg likewise never receives the control-plane tx.
    expect(newStore.calls[0]?.args[1]).toBeUndefined();
  });
});

describe("RoutingRunStore.findManyWaitpointTags", () => {
  it("fans out to both stores, de-dupes NEW-wins, and re-imposes orderBy/take/skip globally", async () => {
    const { router, newStore, legacyStore } = buildRouter();
    const result = (await router.findManyWaitpointTags({
      where: { environmentId: "env" },
      orderBy: { id: "desc" },
      take: 2,
      skip: 1,
    })) as Array<{ id: string; src: string }>;

    // Union {a,b,c} sorted desc = [c,b,a]; slice(1,3) = [b,a]; "a" collides so NEW wins.
    expect(result.map((r) => r.id)).toEqual(["b", "a"]);
    expect(result.find((r) => r.id === "a")?.src).toBe("new");

    // Each leg is widened: skip dropped to 0, take widened to skip+take.
    expect((newStore.calls[0]!.args[0] as { take: number; skip: number }).take).toBe(3);
    expect((newStore.calls[0]!.args[0] as { take: number; skip: number }).skip).toBe(0);
    expect((legacyStore.calls[0]!.args[0] as { take: number; skip: number }).take).toBe(3);
  });
});
