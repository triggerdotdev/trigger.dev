// A redis-primary snapshot has no Postgres CompletedWaitpoint join rows, so the routing store's
// cross-DB completed-waitpoint re-resolve must not query the join for it. Postgres and mirrored
// snapshots keep the re-resolve.

import { describe, expect, it, vi } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import { metadataWithSnapshotResidency } from "./snapshotResidency.js";
import type { RunStore } from "./types.js";

function stubStore(snapshot: Record<string, unknown>) {
  const findLatestExecutionSnapshot = vi.fn(async () => snapshot);
  const findSnapshotCompletedWaitpointIds = vi.fn(async () => [] as string[]);
  const store = {
    findLatestExecutionSnapshot,
    findSnapshotCompletedWaitpointIds,
  } as unknown as RunStore;
  return { store, findSnapshotCompletedWaitpointIds };
}

function routerFor(metadata: unknown) {
  const snapshot = { id: "snapshot_1", runId: "run_1", completedWaitpoints: [], metadata };
  const owning = stubStore(snapshot);
  const other = stubStore(snapshot);
  const router = new RoutingRunStore({
    new: owning.store,
    legacy: other.store,
    classify: () => "NEW",
  });
  return { router, owning, other };
}

describe("RoutingRunStore.findLatestExecutionSnapshot completed-waitpoint join", () => {
  it("skips the join read for a redis-primary snapshot", async () => {
    const { router, owning, other } = routerFor(
      metadataWithSnapshotResidency(undefined, "redis-primary")
    );
    const snapshot = await router.findLatestExecutionSnapshot("run_1");
    expect(snapshot?.id).toBe("snapshot_1");
    expect(owning.findSnapshotCompletedWaitpointIds).not.toHaveBeenCalled();
    expect(other.findSnapshotCompletedWaitpointIds).not.toHaveBeenCalled();
  });

  it.each([
    ["mirrored", metadataWithSnapshotResidency(undefined, "mirrored")],
    ["postgres", undefined],
  ])("still reads the join for a %s snapshot", async (_label, metadata) => {
    const { router, owning } = routerFor(metadata);
    await router.findLatestExecutionSnapshot("run_1");
    expect(owning.findSnapshotCompletedWaitpointIds).toHaveBeenCalledTimes(1);
    expect(owning.findSnapshotCompletedWaitpointIds.mock.calls[0]?.[0]).toBe("snapshot_1");
  });
});
