import { describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { WarmStartVerificationService } from "./warmStartVerificationService.js";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";

// The TimerWheel ticks every 100ms, so a 1000ms delay (the env minimum)
// fires within ~1.1s.
const DELAY_MS = 1_000;
// Long enough that a pending verification would certainly have fired.
const SETTLE_MS = 1_600;

const DEQUEUED_SNAPSHOT_ID = "snapshot_dequeued";

function makeMessage(runFriendlyId = "run_1"): DequeuedMessage {
  return {
    run: { friendlyId: runFriendlyId },
    snapshot: { friendlyId: DEQUEUED_SNAPSHOT_ID },
  } as unknown as DequeuedMessage;
}

function createService(opts: { latestSnapshotId?: string; probeError?: boolean }) {
  const getLatestSnapshot = vi.fn(async (_runId: string) =>
    opts.probeError
      ? { success: false as const, error: "connection refused" }
      : {
          success: true as const,
          data: { execution: { snapshot: { friendlyId: opts.latestSnapshotId } } },
        }
  );

  const createWorkload = vi.fn(async () => {});

  const service = new WarmStartVerificationService({
    workerClient: { getLatestSnapshot } as unknown as SupervisorHttpClient,
    delayMs: DELAY_MS,
    createWorkload,
    wideEventOpts: { service: "supervisor-test", env: {}, enabled: false },
  });

  return { service, getLatestSnapshot, createWorkload };
}

describe("WarmStartVerificationService", () => {
  it("falls back to a cold create when the snapshot is unchanged", async () => {
    const { service, createWorkload } = createService({
      latestSnapshotId: DEQUEUED_SNAPSHOT_ID,
    });
    try {
      const message = makeMessage();
      const timings = { warmStartCheckMs: 12 };
      service.schedule(message, timings);

      await vi.waitFor(() => expect(createWorkload).toHaveBeenCalledTimes(1), {
        timeout: 3_000,
      });
      expect(createWorkload).toHaveBeenCalledWith(message, timings);
    } finally {
      service.stop();
    }
  });

  it("does nothing when the snapshot has moved on (delivered)", async () => {
    const { service, getLatestSnapshot, createWorkload } = createService({
      latestSnapshotId: "snapshot_executing",
    });
    try {
      service.schedule(makeMessage(), { warmStartCheckMs: 12 });

      await vi.waitFor(() => expect(getLatestSnapshot).toHaveBeenCalledTimes(1), {
        timeout: 3_000,
      });
      await sleep(100);
      expect(createWorkload).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("never falls back when the probe errors", async () => {
    const { service, getLatestSnapshot, createWorkload } = createService({ probeError: true });
    try {
      service.schedule(makeMessage(), { warmStartCheckMs: 12 });

      await vi.waitFor(() => expect(getLatestSnapshot).toHaveBeenCalledTimes(1), {
        timeout: 3_000,
      });
      await sleep(100);
      expect(createWorkload).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("cancel before the delay prevents the probe entirely", async () => {
    const { service, getLatestSnapshot, createWorkload } = createService({
      latestSnapshotId: DEQUEUED_SNAPSHOT_ID,
    });
    try {
      service.schedule(makeMessage(), { warmStartCheckMs: 12 });

      expect(service.cancel("run_1")).toBe(true);

      await sleep(SETTLE_MS);
      expect(getLatestSnapshot).not.toHaveBeenCalled();
      expect(createWorkload).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it("re-scheduling the same run replaces the pending verification", async () => {
    const { service, getLatestSnapshot } = createService({
      latestSnapshotId: "snapshot_executing",
    });
    try {
      service.schedule(makeMessage(), { warmStartCheckMs: 1 });
      service.schedule(makeMessage(), { warmStartCheckMs: 2 });

      await vi.waitFor(() => expect(getLatestSnapshot).toHaveBeenCalledTimes(1), {
        timeout: 3_000,
      });
      await sleep(SETTLE_MS);
      expect(getLatestSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      service.stop();
    }
  });
});
