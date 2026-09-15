import { describe, expect, it, vi } from "vitest";
import { resolveBatchTaskRunForRealtime } from "~/v3/realtime/resolveBatchForRealtime.server";

// The realtime batch route reads the batch client-less (replica). Under replica lag a just-created batch
// misses; `shouldRetryNotFound` covers the zodfetch GET, but the Electric ShapeStream consumer
// (self-hosters) ignores `x-should-retry`, so the route must re-read the owning PRIMARY on a miss.
// Passing a (non-replica) writer client flips each store leg to its own primary.
function laggingStore(batch: { id: string; friendlyId: string }) {
  return {
    findBatchTaskRunByFriendlyId: vi.fn(
      async (_friendlyId: string, _envId: string, _args: unknown, client?: unknown) =>
        client ? batch : null
    ),
  };
}

describe("resolveBatchTaskRunForRealtime", () => {
  it("re-reads the primary when the replica misses a fresh batch", async () => {
    const store = laggingStore({ id: "b_1", friendlyId: "batch_1" });
    const found = await resolveBatchTaskRunForRealtime("batch_1", "env_1", {
      store: store as never,
      writer: {} as never,
    });
    expect(found).toEqual({ id: "b_1", friendlyId: "batch_1" });
    expect(store.findBatchTaskRunByFriendlyId).toHaveBeenCalledTimes(2);
  });

  it("returns null when the batch is genuinely absent on both replica and primary", async () => {
    const store = { findBatchTaskRunByFriendlyId: vi.fn(async () => null) };
    const found = await resolveBatchTaskRunForRealtime("nope", "env_1", {
      store: store as never,
      writer: {} as never,
    });
    expect(found).toBeNull();
  });

  it("does not re-read the primary when the replica already has the batch", async () => {
    const store = {
      findBatchTaskRunByFriendlyId: vi.fn(async () => ({ id: "b_2", friendlyId: "batch_2" })),
    };
    await resolveBatchTaskRunForRealtime("batch_2", "env_1", {
      store: store as never,
      writer: {} as never,
    });
    expect(store.findBatchTaskRunByFriendlyId).toHaveBeenCalledTimes(1);
  });
});
