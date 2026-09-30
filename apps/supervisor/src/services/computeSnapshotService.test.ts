import { describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ComputeSnapshotService,
  type PublishedSuspend,
  type RunnerSuspendRequest,
  type RunnerSuspendResult,
} from "./computeSnapshotService.js";
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

  const submitSuspendCompletion = vi.fn(async () => ({ success: true }));

  const service = new ComputeSnapshotService({
    computeManager,
    workerClient: { submitSuspendCompletion } as unknown as SupervisorHttpClient,
    wideEventOpts: { service: "supervisor-test", env: {}, enabled: false },
    snapshotCallbackSecret: "test-secret",
  });

  return { service, snapshot, submitSuspendCompletion };
}

function dispatchedMetadata(snapshot: {
  mock: { calls: Array<Array<{ metadata?: Record<string, string> }>> };
}) {
  const metadata = snapshot.mock.calls[0]?.[0]?.metadata;
  if (!metadata) {
    throw new Error("Snapshot was not dispatched");
  }
  return metadata;
}

function delayedSnapshot(runnerId = "runner-1") {
  return {
    runnerId,
    runFriendlyId: "run_1",
    snapshotFriendlyId: "snapshot_1",
  };
}

function createRunnerService(
  outcome: { ok: true; location: string } | { ok: false; error: string },
  requested: { ok: true } | { ok: false; error: string } = { ok: true },
  published: PublishedSuspend[] = []
) {
  const requestSuspend = vi.fn(async (_opts: RunnerSuspendRequest) => requested);
  const awaitSuspend = vi.fn(
    async (_opts: { runnerId: string; snapshotFriendlyId: string }): Promise<RunnerSuspendResult> =>
      outcome
  );
  const publishedSuspends = vi.fn(async () => published);
  const publishedSuspendOf = vi.fn(
    async (_runnerId: string): Promise<PublishedSuspend | undefined> => undefined
  );
  const markSuspendSubmitted = vi.fn(
    async (_opts: { runnerId: string; snapshotFriendlyId: string }) => {}
  );
  const submitSuspendCompletion = vi.fn(
    async (): Promise<{ success: boolean; error?: string }> => ({ success: true })
  );
  const service = new ComputeSnapshotService({
    runnerSnapshotter: {
      snapshotDelayMs: DELAY_MS,
      snapshotDispatchLimit: 1,
      requestSuspend,
      awaitSuspend,
      publishedSuspends,
      publishedSuspendOf,
      markSuspendSubmitted,
    },
    workerClient: { submitSuspendCompletion } as unknown as SupervisorHttpClient,
    wideEventOpts: { service: "supervisor-test", env: {}, enabled: false },
    snapshotCallbackSecret: "test-secret",
  });
  return {
    service,
    requestSuspend,
    awaitSuspend,
    publishedSuspends,
    publishedSuspendOf,
    markSuspendSubmitted,
    submitSuspendCompletion,
  };
}

describe("ComputeSnapshotService with a runner snapshotter", () => {
  it("submits the snapshot the backend took, with no callback", async () => {
    const { service, requestSuspend, awaitSuspend, submitSuspendCompletion } = createRunnerService({
      ok: true,
      location: "snap-1",
    });
    try {
      const owner = { envId: "env_1", deploymentFriendlyId: "deployment_1" };
      service.schedule("run_1", { ...delayedSnapshot(), owner });

      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      expect(requestSuspend).toHaveBeenCalledWith({
        runnerId: "runner-1",
        runFriendlyId: "run_1",
        snapshotFriendlyId: "snapshot_1",
        owner,
      });
      expect(awaitSuspend).toHaveBeenCalledWith({
        runnerId: "runner-1",
        snapshotFriendlyId: "snapshot_1",
      });
      expect(submitSuspendCompletion).toHaveBeenCalledWith({
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: { success: true, checkpoint: { type: "COMPUTE", location: "snap-1" } },
      });
    } finally {
      service.stop();
    }
  });

  it("submits a failed suspend as a failure", async () => {
    const { service, submitSuspendCompletion } = createRunnerService({
      ok: false,
      error: "SnapshotFailed: boom",
    });
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      expect(submitSuspendCompletion).toHaveBeenCalledWith({
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: { success: false, error: "SnapshotFailed: boom" },
      });
    } finally {
      service.stop();
    }
  });

  it("submits a refused request as a failure without waiting", async () => {
    const { service, awaitSuspend, submitSuspendCompletion } = createRunnerService(
      { ok: true, location: "snap-1" },
      { ok: false, error: "the Runner belongs to another deployment" }
    );
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      expect(awaitSuspend).not.toHaveBeenCalled();
      expect(submitSuspendCompletion).toHaveBeenCalledWith({
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: { success: false, error: "the Runner belongs to another deployment" },
      });
    } finally {
      service.stop();
    }
  });

  it("marks the suspend submitted once the platform accepts it", async () => {
    const { service, submitSuspendCompletion, markSuspendSubmitted } = createRunnerService({
      ok: true,
      location: "snap-1",
    });
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(markSuspendSubmitted).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      expect(markSuspendSubmitted).toHaveBeenCalledWith({
        runnerId: "runner-1",
        snapshotFriendlyId: "snapshot_1",
      });
      expect(submitSuspendCompletion.mock.invocationCallOrder[0]).toBeLessThan(
        markSuspendSubmitted.mock.invocationCallOrder[0]!
      );
    } finally {
      service.stop();
    }
  });

  it("leaves the suspend unmarked when the platform refuses it, for recovery to retry", async () => {
    const { service, submitSuspendCompletion, markSuspendSubmitted } = createRunnerService({
      ok: true,
      location: "snap-1",
    });
    submitSuspendCompletion.mockResolvedValue({ success: false, error: "unavailable" });
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      await sleep(50);
      expect(markSuspendSubmitted).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("marks nothing when the request was refused, since nothing reached the Runner", async () => {
    const { service, submitSuspendCompletion, markSuspendSubmitted } = createRunnerService(
      { ok: true, location: "snap-1" },
      { ok: false, error: "the Runner belongs to another deployment" }
    );
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      await sleep(50);
      expect(markSuspendSubmitted).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("holds a dispatch slot for the request only, not the wait", async () => {
    const { service, requestSuspend, awaitSuspend } = createRunnerService({
      ok: true,
      location: "snap-1",
    });
    awaitSuspend.mockImplementation(() => new Promise(() => {}));
    try {
      service.schedule("run_1", delayedSnapshot("runner-1"));
      service.schedule("run_2", delayedSnapshot("runner-2"));

      await vi.waitFor(() => expect(requestSuspend).toHaveBeenCalledTimes(2), { timeout: 2_000 });
      expect(awaitSuspend).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
    }
  });

  it("keeps the delay, so a cancelled suspend never reaches the backend", async () => {
    const { service, requestSuspend } = createRunnerService({ ok: true, location: "snap-1" });
    try {
      service.schedule("run_1", delayedSnapshot());
      expect(service.cancel("run_1")).toBe(true);

      await sleep(SETTLE_MS);
      expect(requestSuspend).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("refuses to construct with no backend or with both", () => {
    const common = {
      workerClient: {} as SupervisorHttpClient,
      wideEventOpts: { service: "supervisor-test", env: {}, enabled: false },
      snapshotCallbackSecret: "test-secret",
    };
    const runnerSnapshotter = {
      snapshotDelayMs: DELAY_MS,
      snapshotDispatchLimit: 1,
      requestSuspend: vi.fn(),
      awaitSuspend: vi.fn(),
      publishedSuspends: vi.fn(),
      publishedSuspendOf: vi.fn(),
      markSuspendSubmitted: vi.fn(),
    };
    const computeManager = {
      snapshotDelayMs: DELAY_MS,
      snapshotDispatchLimit: 1,
    } as unknown as ComputeWorkloadManager;

    expect(() => new ComputeSnapshotService(common)).toThrow();
    expect(
      () => new ComputeSnapshotService({ ...common, runnerSnapshotter, computeManager })
    ).toThrow();
  });
});

describe("ComputeSnapshotService recovering suspends after a restart", () => {
  // The operator wrote the outcome to the Runner, then the supervisor that asked
  // restarted before submitting it; a fresh service holds nothing in memory.
  const published: PublishedSuspend = {
    runnerId: "runner-1",
    runFriendlyId: "run_1",
    snapshotFriendlyId: "snapshot_1",
    outcome: { ok: true, location: "node-a/snap-1" },
  };

  it("submits an outcome published before the restart, then marks it", async () => {
    const { service, submitSuspendCompletion, markSuspendSubmitted, requestSuspend } =
      createRunnerService({ ok: true, location: "unused" }, { ok: true }, [published]);
    try {
      await vi.waitFor(() => expect(markSuspendSubmitted).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      expect(submitSuspendCompletion).toHaveBeenCalledWith({
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: { success: true, checkpoint: { type: "COMPUTE", location: "node-a/snap-1" } },
      });
      expect(markSuspendSubmitted).toHaveBeenCalledWith({
        runnerId: "runner-1",
        snapshotFriendlyId: "snapshot_1",
      });
      expect(requestSuspend).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("retries on the next pass when the submission fails", async () => {
    const { service, submitSuspendCompletion, markSuspendSubmitted } = createRunnerService(
      { ok: true, location: "unused" },
      { ok: true },
      [published]
    );
    submitSuspendCompletion.mockResolvedValueOnce({ success: false, error: "unavailable" });
    try {
      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      expect(markSuspendSubmitted).not.toHaveBeenCalled();
      // Let the startup pass finish, or this one is skipped as overlapping.
      await sleep(50);

      await service.recoverSuspends();
      expect(submitSuspendCompletion).toHaveBeenCalledTimes(2);
      expect(markSuspendSubmitted).toHaveBeenCalledTimes(1);
    } finally {
      service.stop();
    }
  });

  it("leaves a suspend this process is still waiting on to that wait", async () => {
    const { service, awaitSuspend, publishedSuspends, submitSuspendCompletion } =
      createRunnerService({ ok: true, location: "snap-1" });
    let answer: (outcome: RunnerSuspendResult) => void = () => {};
    awaitSuspend.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    try {
      service.schedule("run_1", delayedSnapshot());
      await vi.waitFor(() => expect(awaitSuspend).toHaveBeenCalled(), { timeout: 2_000 });

      publishedSuspends.mockResolvedValue([published]);
      await service.recoverSuspends();
      expect(submitSuspendCompletion).not.toHaveBeenCalled();

      answer({ ok: true, location: "node-a/snap-1" });
      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
    } finally {
      service.stop();
    }
  });

  // A may already be answered on the Runner while its own waiter has yet to
  // read or submit it; B would replace that answer.
  it("refuses a new request while an earlier one on the Runner is in flight", async () => {
    const { service, awaitSuspend, requestSuspend, submitSuspendCompletion } = createRunnerService({
      ok: true,
      location: "node-a/snap-1",
    });
    let answer: (outcome: RunnerSuspendResult) => void = () => {};
    awaitSuspend.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    try {
      service.schedule("run_1", delayedSnapshot());
      await vi.waitFor(() => expect(awaitSuspend).toHaveBeenCalled(), { timeout: 2_000 });

      service.schedule("run_2", {
        runnerId: "runner-1",
        runFriendlyId: "run_2",
        snapshotFriendlyId: "snapshot_2",
      });
      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      expect(submitSuspendCompletion).toHaveBeenCalledWith({
        runId: "run_2",
        snapshotId: "snapshot_2",
        body: {
          success: false,
          error: "an earlier suspend on this Runner is still in flight; retry later",
        },
      });
      expect(requestSuspend).toHaveBeenCalledTimes(1);

      answer({ ok: true, location: "node-a/snap-1" });
      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(2), {
        timeout: 2_000,
      });
      expect(submitSuspendCompletion).toHaveBeenLastCalledWith({
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: { success: true, checkpoint: { type: "COMPUTE", location: "node-a/snap-1" } },
      });
    } finally {
      service.stop();
    }
  });

  // A was answered but its submission was interrupted; B on the same Runner
  // would replace A's status, the only place recovery can find it.
  it("delivers an undelivered earlier answer before a new request replaces it", async () => {
    const {
      service,
      requestSuspend,
      publishedSuspendOf,
      markSuspendSubmitted,
      submitSuspendCompletion,
    } = createRunnerService({ ok: true, location: "node-a/snap-2" });
    publishedSuspendOf.mockResolvedValue(published);
    submitSuspendCompletion.mockResolvedValueOnce({ success: false, error: "unavailable" });
    const later = {
      runnerId: "runner-1",
      runFriendlyId: "run_2",
      snapshotFriendlyId: "snapshot_2",
    };
    try {
      await sleep(50);
      service.schedule("run_2", later);

      await vi.waitFor(() => expect(submitSuspendCompletion).toHaveBeenCalledTimes(2), {
        timeout: 2_000,
      });
      expect(submitSuspendCompletion).toHaveBeenNthCalledWith(1, {
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: { success: true, checkpoint: { type: "COMPUTE", location: "node-a/snap-1" } },
      });
      expect(submitSuspendCompletion).toHaveBeenNthCalledWith(2, {
        runId: "run_2",
        snapshotId: "snapshot_2",
        body: {
          success: false,
          error: "an earlier suspend on this Runner has not reached the platform yet; retry later",
        },
      });
      expect(requestSuspend).not.toHaveBeenCalled();
      expect(markSuspendSubmitted).not.toHaveBeenCalled();

      service.schedule("run_2", later);

      await vi.waitFor(() => expect(requestSuspend).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      expect(submitSuspendCompletion).toHaveBeenNthCalledWith(3, {
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: { success: true, checkpoint: { type: "COMPUTE", location: "node-a/snap-1" } },
      });
      expect(markSuspendSubmitted).toHaveBeenNthCalledWith(1, {
        runnerId: "runner-1",
        snapshotFriendlyId: "snapshot_1",
      });
      expect(markSuspendSubmitted.mock.invocationCallOrder[0]).toBeLessThan(
        requestSuspend.mock.invocationCallOrder[0]!
      );
    } finally {
      service.stop();
    }
  });

  it("survives a failed listing", async () => {
    const { service, publishedSuspends, submitSuspendCompletion } = createRunnerService({
      ok: true,
      location: "unused",
    });
    publishedSuspends.mockRejectedValue(new Error("forbidden"));
    try {
      await sleep(50);
      await expect(service.recoverSuspends()).resolves.toBeUndefined();
      expect(submitSuspendCompletion).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });
});

describe("ComputeSnapshotService", () => {
  it("refuses to construct with an empty callback secret", () => {
    const computeManager = {
      snapshotDelayMs: DELAY_MS,
      snapshotDispatchLimit: 1,
      snapshot: vi.fn(async () => true),
    } as unknown as ComputeWorkloadManager;

    expect(
      () =>
        new ComputeSnapshotService({
          computeManager,
          workerClient: {} as SupervisorHttpClient,
          wideEventOpts: { service: "supervisor-test", env: {}, enabled: false },
          snapshotCallbackSecret: "",
        })
    ).toThrow();
  });

  it("dispatches a scheduled snapshot after the delay", async () => {
    const { service, snapshot } = createService();
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      expect(snapshot).toHaveBeenCalledWith({
        runnerId: "runner-1",
        metadata: expect.objectContaining({
          runId: "run_1",
          snapshotFriendlyId: "snapshot_1",
          snapshotCallbackNonce: expect.any(String),
          snapshotCallbackToken: expect.any(String),
        }),
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
        metadata: expect.objectContaining({
          runId: "run_1",
          snapshotFriendlyId: "snapshot_2",
          snapshotCallbackNonce: expect.any(String),
          snapshotCallbackToken: expect.any(String),
        }),
      });
    } finally {
      service.stop();
    }
  });

  it("accepts a snapshot callback with the dispatched token", async () => {
    const { service, snapshot, submitSuspendCompletion } = createService();
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      const metadata = dispatchedMetadata(snapshot);

      const result = await service.handleCallback({
        status: "completed",
        instance_id: "instance_1",
        snapshot_id: "compute_snapshot_1",
        metadata,
      });

      expect(result).toEqual({ ok: true, status: 200 });
      expect(submitSuspendCompletion).toHaveBeenCalledWith({
        runId: "run_1",
        snapshotId: "snapshot_1",
        body: {
          success: true,
          checkpoint: {
            type: "COMPUTE",
            location: "compute_snapshot_1",
          },
        },
      });
    } finally {
      service.stop();
    }
  });

  it("rejects a snapshot callback without a valid token", async () => {
    const { service, submitSuspendCompletion } = createService();
    try {
      const result = await service.handleCallback({
        status: "completed",
        instance_id: "instance_1",
        snapshot_id: "compute_snapshot_1",
        metadata: { runId: "run_1", snapshotFriendlyId: "snapshot_1" },
      });

      expect(result).toEqual({ ok: false, status: 401 });
      expect(submitSuspendCompletion).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("rejects a snapshot callback whose token is for a different snapshot", async () => {
    const { service, snapshot, submitSuspendCompletion } = createService();
    try {
      service.schedule("run_1", delayedSnapshot());

      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      const metadata = dispatchedMetadata(snapshot);

      const result = await service.handleCallback({
        status: "completed",
        instance_id: "instance_1",
        snapshot_id: "compute_snapshot_1",
        metadata: { ...metadata, snapshotFriendlyId: "snapshot_2" },
      });

      expect(result).toEqual({ ok: false, status: 401 });
      expect(submitSuspendCompletion).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });
});
