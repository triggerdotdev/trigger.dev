import { describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { ComputeSnapshotService } from "./computeSnapshotService.js";
import type { ComputeWorkloadManager } from "../workloadManager/compute.js";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";

// The TimerWheel ticks every 100ms, so a 200ms delay dispatches within ~300ms.
const DELAY_MS = 200;
// Long enough that a pending snapshot would certainly have dispatched.
const SETTLE_MS = 600;

function createService() {
  const snapshot = vi.fn(
    async (_opts: { runnerId: string; metadata: Record<string, string> }) => true
  );

  const computeManager = {
    snapshotDelayMs: DELAY_MS,
    snapshotDispatchLimit: 1,
    snapshot,
  } as unknown as ComputeWorkloadManager;

  const service = new ComputeSnapshotService({
    computeManager,
    workerClient: {} as SupervisorHttpClient,
    wideEventOpts: { service: "supervisor-test", env: {}, enabled: false },
  });

  return { service, snapshot };
}

function delayedSnapshot(runnerId = "runner-1") {
  return {
    runnerId,
    runFriendlyId: "run_1",
    snapshotFriendlyId: "snapshot_1",
  };
}

describe("ComputeSnapshotService", () => {
  it("dispatches a scheduled snapshot after the delay", async () => {
    const { service, snapshot } = createService();
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      expect(snapshot).toHaveBeenCalledWith({
        runnerId: "runner-1",
        metadata: { runId: "run_1", snapshotFriendlyId: "snapshot_1" },
      });
    } finally {
      service.stop();
    }
  });

  it("cancel before the delay expires prevents the dispatch", async () => {
    const { service, snapshot } = createService();
    try {
      service.schedule("run_1", delayedSnapshot());

      expect(service.cancel("run_1")).toBe(true);

      await sleep(SETTLE_MS);
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("cancel returns false when nothing is pending", () => {
    const { service } = createService();
    try {
      expect(service.cancel("run_1")).toBe(false);
    } finally {
      service.stop();
    }
  });

  it("cancel with a matching runnerId cancels the pending snapshot", async () => {
    const { service, snapshot } = createService();
    try {
      service.schedule("run_1", delayedSnapshot("runner-a"));

      expect(service.cancel("run_1", "runner-a")).toBe(true);

      await sleep(SETTLE_MS);
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("cancel with a different runnerId leaves the pending snapshot alone", async () => {
    const { service, snapshot } = createService();
    try {
      service.schedule("run_1", delayedSnapshot("runner-a"));

      // A stale runner for a reassigned run must not cancel the new runner's snapshot.
      expect(service.cancel("run_1", "runner-b")).toBe(false);

      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ runnerId: "runner-a" }));
    } finally {
      service.stop();
    }
  });

  it("re-scheduling the same run replaces the pending snapshot", async () => {
    const { service, snapshot } = createService();
    try {
      service.schedule("run_1", delayedSnapshot());
      service.schedule("run_1", {
        runnerId: "runner-1",
        runFriendlyId: "run_1",
        snapshotFriendlyId: "snapshot_2",
      });

      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      await sleep(SETTLE_MS);

      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenCalledWith({
        runnerId: "runner-1",
        metadata: { runId: "run_1", snapshotFriendlyId: "snapshot_2" },
      });
    } finally {
      service.stop();
    }
  });
});
