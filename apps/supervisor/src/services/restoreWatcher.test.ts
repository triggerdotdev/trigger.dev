import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import type { RestoreWatchResult } from "../workloadManager/runCrd.js";
import { RestoreWatcher, type RestoreFailure } from "./restoreWatcher.js";

const failed: RestoreWatchResult = {
  ok: false,
  reason: "StartError",
  error: "StartError: pulling the image: 401",
  uid: "uid-a",
};

function setup(opts: { reportFailure?: (failure: RestoreFailure) => Promise<void> } = {}) {
  const outcomes: Array<{ signal: AbortSignal; resolve: (result: RestoreWatchResult) => void }> =
    [];
  const awaitRestore = vi.fn(
    (_restore: unknown, _onPhase: unknown, signal: AbortSignal) =>
      new Promise<RestoreWatchResult>((resolve) => outcomes.push({ signal, resolve }))
  );
  const reportFailure = vi.fn(opts.reportFailure ?? (async () => {}));
  const heartbeat = vi.fn(async () => {});
  const watcher = new RestoreWatcher({
    awaitRestore,
    heartbeat,
    heartbeatIntervalMs: 60_000,
    reportFailure,
    register: new Registry(),
  });
  return { watcher, outcomes, awaitRestore, reportFailure, heartbeat };
}

const target = {
  runFriendlyId: "run_a",
  snapshotFriendlyId: "snapshot_1",
};

describe("RestoreWatcher", () => {
  it("reports a failed restore with the dequeued snapshot", async () => {
    const { watcher, outcomes, reportFailure } = setup();

    const watched = watcher.watch(target, { runnerId: "runner-a", uid: "uid-a" });
    outcomes[0]!.resolve(failed);
    await watched;

    expect(reportFailure).toHaveBeenCalledWith({
      runFriendlyId: "run_a",
      snapshotFriendlyId: "snapshot_1",
      runnerId: "runner-a",
      outcome: failed,
    });
  });

  it("names the snapshot dequeued last when the restore is redelivered", async () => {
    const { watcher, outcomes, awaitRestore, reportFailure } = setup();

    const watched = watcher.watch(target, { runnerId: "runner-a", uid: "uid-a" });
    await watcher.watch(
      { runFriendlyId: "run_a", snapshotFriendlyId: "snapshot_2" },
      { runnerId: "runner-a", uid: "uid-a" }
    );
    outcomes[0]!.resolve(failed);
    await watched;

    expect(awaitRestore).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotFriendlyId: "snapshot_2" })
    );
  });

  it("reports nothing for a watch the shutdown ended, whatever it resolved with", async () => {
    const { watcher, outcomes, reportFailure } = setup();

    const watched = watcher.watch(target, { runnerId: "runner-a", uid: "uid-a" });
    await watcher.stop();
    expect(outcomes[0]!.signal.aborted).toBe(true);
    outcomes[0]!.resolve(failed);
    await watched;

    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("starts no watch once stopped", async () => {
    const { watcher, awaitRestore, heartbeat } = setup();

    await watcher.stop();
    await watcher.watch(target, { runnerId: "runner-a", uid: "uid-a" });

    expect(awaitRestore).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });

  // The informer outlives the watcher in a shutdown and can still find a failed
  // Runner. Left for the next process, which finds it again and reports it.
  it("refuses a report once stopping", async () => {
    const { watcher, reportFailure } = setup();
    await watcher.stop();

    await watcher.report({ ...target, runnerId: "runner-a", outcome: failed });

    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("waits on stop for a report already under way", async () => {
    let finishReport!: () => void;
    const { watcher, outcomes } = setup({
      reportFailure: () => new Promise<void>((resolve) => (finishReport = resolve)),
    });

    const watched = watcher.watch(target, { runnerId: "runner-a", uid: "uid-a" });
    outcomes[0]!.resolve(failed);
    await vi.waitFor(() => expect(finishReport).toBeDefined());
    let stopped = false;
    const stopping = watcher.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    finishReport();
    await stopping;
    await watched;
    expect(stopped).toBe(true);
  });
});
