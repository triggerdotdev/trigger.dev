import pLimit from "p-limit";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { TimerWheel } from "./timerWheel.js";
import {
  emitOneShot,
  fromContext,
  recordPhaseSince,
  runWideEvent,
  setExtra,
  type WideEventOptions,
} from "../wideEvents/index.js";

type DelayedSnapshot = {
  runnerId: string;
  runFriendlyId: string;
  snapshotFriendlyId: string;
  /** From the caller's verified deployment token, when it carried one. */
  owner?: RunnerOwner;
};

export type RunnerSuspendResult = { ok: true; location: string } | { ok: false; error: string };
export type RunnerSuspendRequested = { ok: true } | { ok: false; error: string };
type RunnerOwner = { envId: string; deploymentFriendlyId: string };
export type RunnerSuspendRequest = {
  runnerId: string;
  runFriendlyId: string;
  snapshotFriendlyId: string;
  owner?: RunnerOwner;
};
export type PublishedSuspend = {
  runnerId: string;
  runFriendlyId: string;
  snapshotFriendlyId: string;
  outcome: RunnerSuspendResult;
};

const SUSPEND_RECOVERY_INTERVAL_MS = 60_000;

/**
 * The backend that takes the snapshot and answers with the outcome. Only the
 * request counts against the dispatch limit: the wait lasts as long as the snapshot, and a queue behind it
 * would hold suspends that can no longer be cancelled.
 */
export interface RunnerSnapshotter {
  snapshotDelayMs: number;
  snapshotDispatchLimit: number;
  requestSuspend(opts: RunnerSuspendRequest): Promise<RunnerSuspendRequested>;
  awaitSuspend(opts: {
    runnerId: string;
    snapshotFriendlyId: string;
  }): Promise<RunnerSuspendResult>;
  /** Answered suspends not yet marked submitted, which outlive this process. */
  publishedSuspends(): Promise<PublishedSuspend[]>;
  publishedSuspendOf(runnerId: string): Promise<PublishedSuspend | undefined>;
  markSuspendSubmitted(opts: { runnerId: string; snapshotFriendlyId: string }): Promise<void>;
}

export type ComputeSnapshotServiceOptions = {
  runnerSnapshotter: RunnerSnapshotter;
  workerClient: SupervisorHttpClient;
  wideEventOpts: WideEventOptions;
  suspendRecoveryIntervalMs?: number;
};

export class ComputeSnapshotService {
  private readonly logger = new SimpleStructuredLogger("compute-snapshot-service");

  private readonly timerWheel: TimerWheel<DelayedSnapshot>;
  private readonly dispatchLimit: ReturnType<typeof pLimit>;

  private readonly runnerSnapshotter: RunnerSnapshotter;
  private readonly snapshotDelayMs: number;
  private readonly workerClient: SupervisorHttpClient;
  private readonly wideEventOpts: WideEventOptions;
  private readonly suspendsInFlight = new Set<string>();
  private suspendRecoveryTimer?: ReturnType<typeof setInterval>;
  private recoveringSuspends = false;

  constructor(opts: ComputeSnapshotServiceOptions) {
    this.runnerSnapshotter = opts.runnerSnapshotter;
    this.snapshotDelayMs = opts.runnerSnapshotter.snapshotDelayMs;
    this.workerClient = opts.workerClient;
    this.wideEventOpts = opts.wideEventOpts;

    this.dispatchLimit = pLimit(opts.runnerSnapshotter.snapshotDispatchLimit);
    this.timerWheel = new TimerWheel<DelayedSnapshot>({
      delayMs: this.snapshotDelayMs,
      onExpire: (item) => {
        this.dispatch(item.data).catch((error) => {
          this.logger.error("Snapshot dispatch failed", {
            runId: item.data.runFriendlyId,
            runnerId: item.data.runnerId,
            error,
          });
        });
      },
    });
    this.timerWheel.start();

    this.suspendRecoveryTimer = setInterval(
      () => void this.recoverSuspends(),
      opts.suspendRecoveryIntervalMs ?? SUSPEND_RECOVERY_INTERVAL_MS
    );
    this.suspendRecoveryTimer.unref();
    void this.recoverSuspends();
  }

  /**
   * Submits suspend outcomes the backend published that no process delivered,
   * such as one answered while the supervisor restarted, or whose submission
   * failed. A repeat is harmless: the platform discards a checkpoint for a
   * snapshot that is no longer current.
   */
  async recoverSuspends(): Promise<void> {
    const runnerSnapshotter = this.runnerSnapshotter;
    if (this.recoveringSuspends) {
      return;
    }
    this.recoveringSuspends = true;
    try {
      const published = await runnerSnapshotter.publishedSuspends();
      for (const suspend of published) {
        if (this.suspendsInFlight.has(suspendKey(suspend))) {
          continue;
        }
        await runWideEvent(
          {
            ...this.wideEventOpts,
            op: "snapshot.recover",
            kind: "scheduled",
            setup: (state) => {
              state.meta.run_id = suspend.runFriendlyId;
              state.meta.snapshot_id = suspend.snapshotFriendlyId;
              state.extras.runner_id = suspend.runnerId;
            },
          },
          () => this.#deliverSuspend(runnerSnapshotter, suspend, suspend.outcome)
        );
      }
    } catch (error) {
      this.logger.error("Suspend recovery failed", { error });
    } finally {
      this.recoveringSuspends = false;
    }
  }

  /**
   * Submits the outcome, then marks it on the Runner so recovery skips it.
   * Returns whether the platform accepted it.
   */
  async #deliverSuspend(
    runnerSnapshotter: RunnerSnapshotter,
    target: { runnerId: string; runFriendlyId: string; snapshotFriendlyId: string },
    outcome: RunnerSuspendResult
  ): Promise<boolean> {
    if (!(await this.#submitCompletion(target.runFriendlyId, target.snapshotFriendlyId, outcome))) {
      return false;
    }
    try {
      await runnerSnapshotter.markSuspendSubmitted({
        runnerId: target.runnerId,
        snapshotFriendlyId: target.snapshotFriendlyId,
      });
    } catch (error) {
      this.logger.warn("Failed to mark suspend submitted", {
        runnerId: target.runnerId,
        snapshotFriendlyId: target.snapshotFriendlyId,
        error,
      });
    }
    return true;
  }

  /**
   * The Runner's status holds only the latest answer, so a new request may
   * replace an earlier one that never reached the platform, leaving nothing
   * for recovery to find. That one is delivered first, and while it cannot be,
   * the new request is refused so the earlier answer stays on the Runner.
   */
  async #deliverEarlierSuspend(
    runnerSnapshotter: RunnerSnapshotter,
    target: { runnerId: string; snapshotFriendlyId: string }
  ): Promise<RunnerSuspendRequested> {
    // An answer its own waiter has yet to read or submit is just as easy to
    // replace, so any other suspend of ours on this Runner holds a new one off.
    const ownKey = suspendKey(target);
    const prefix = `${target.runnerId}/`;
    for (const key of this.suspendsInFlight) {
      if (key !== ownKey && key.startsWith(prefix)) {
        return {
          ok: false,
          error: "an earlier suspend on this Runner is still in flight; retry later",
        };
      }
    }
    let earlier: PublishedSuspend | undefined;
    try {
      earlier = await runnerSnapshotter.publishedSuspendOf(target.runnerId);
    } catch (error) {
      return {
        ok: false,
        error: `suspend request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!earlier || earlier.snapshotFriendlyId === target.snapshotFriendlyId) {
      return { ok: true };
    }
    if (await this.#deliverSuspend(runnerSnapshotter, earlier, earlier.outcome)) {
      return { ok: true };
    }
    return {
      ok: false,
      error: "an earlier suspend on this Runner has not reached the platform yet; retry later",
    };
  }

  /** Schedule a delayed snapshot for a run. Replaces any pending snapshot for the same run. */
  schedule(runFriendlyId: string, data: DelayedSnapshot) {
    this.timerWheel.submit(runFriendlyId, data);
    emitOneShot({
      ...this.wideEventOpts,
      op: "snapshot.schedule",
      kind: "event",
      populate: (state) => {
        state.meta.run_id = runFriendlyId;
        state.meta.snapshot_id = data.snapshotFriendlyId;
        state.extras.runner_id = data.runnerId;
        state.extras.delay_ms = this.snapshotDelayMs;
      },
    });
    this.logger.debug("Snapshot scheduled", {
      runFriendlyId,
      snapshotFriendlyId: data.snapshotFriendlyId,
      delayMs: this.snapshotDelayMs,
    });
  }

  /**
   * Returns true if a pending snapshot was cancelled. With `runnerId`, only that
   * runner's snapshot, so a stale runner cannot cancel a reassigned run's snapshot.
   */
  cancel(runFriendlyId: string, runnerId?: string): boolean {
    if (runnerId) {
      const pending = this.timerWheel.peek(runFriendlyId);
      if (pending && pending.data.runnerId !== runnerId) {
        return false;
      }
    }
    const cancelled = this.timerWheel.cancel(runFriendlyId);
    if (cancelled) {
      emitOneShot({
        ...this.wideEventOpts,
        op: "snapshot.canceled",
        kind: "event",
        populate: (state) => {
          state.meta.run_id = runFriendlyId;
        },
      });
      this.logger.debug("Snapshot cancelled", { runFriendlyId });
    }
    return cancelled;
  }

  /** Tells the platform how the suspend went, which is what lets the run move on. */
  async #submitCompletion(
    runId: string,
    snapshotFriendlyId: string,
    outcome: RunnerSuspendResult
  ): Promise<boolean> {
    const state = fromContext();
    const submitStart = performance.now();
    const result = await this.workerClient.submitSuspendCompletion({
      runId,
      snapshotId: snapshotFriendlyId,
      body: outcome.ok
        ? { success: true, checkpoint: { type: "COMPUTE", location: outcome.location } }
        : { success: false, error: outcome.error },
    });
    recordPhaseSince(
      "submit_completion",
      submitStart,
      result.success ? undefined : new Error(String(result.error))
    );

    if (result.success) {
      this.logger.debug("Suspend completion submitted", { runId, outcome });
    } else {
      setExtra(state, "submit_completion.error", String(result.error));
      this.logger.error("Failed to submit suspend completion", {
        runId,
        snapshotFriendlyId,
        outcome,
        error: result.error,
      });
    }
    return result.success;
  }

  /** Stop the timer wheel, dropping pending snapshots. */
  stop(): string[] {
    // Not dispatched: runners reconnect to a new supervisor, which re-triggers the
    // suspend, and runs continue without snapshots.
    clearInterval(this.suspendRecoveryTimer);
    const remaining = this.timerWheel.stop();
    const droppedRuns = remaining.map((item) => item.key);

    if (droppedRuns.length > 0) {
      this.logger.info("Stopped, dropped pending snapshots", { count: droppedRuns.length });
      this.logger.debug("Dropped snapshot details", { runs: droppedRuns });
    }

    return droppedRuns;
  }

  /** Dispatch a snapshot request to the backend. */
  private async dispatch(snapshot: DelayedSnapshot): Promise<void> {
    await runWideEvent(
      {
        ...this.wideEventOpts,
        op: "snapshot.dispatch",
        kind: "scheduled",
        setup: (state) => {
          state.meta.run_id = snapshot.runFriendlyId;
          state.meta.snapshot_id = snapshot.snapshotFriendlyId;
          state.extras.runner_id = snapshot.runnerId;
        },
      },
      async () => {
        const runnerSnapshotter = this.runnerSnapshotter;
        const target = {
          runnerId: snapshot.runnerId,
          snapshotFriendlyId: snapshot.snapshotFriendlyId,
        };
        const key = suspendKey(target);
        this.suspendsInFlight.add(key);
        try {
          const requested = await this.dispatchLimit(async () => {
            const earlier = await this.#deliverEarlierSuspend(runnerSnapshotter, target);
            if (!earlier.ok) {
              return earlier;
            }
            return runnerSnapshotter.requestSuspend({
              ...target,
              runFriendlyId: snapshot.runFriendlyId,
              owner: snapshot.owner,
            });
          });
          if (!requested.ok) {
            setExtra(fromContext(), "snapshot.error", requested.error);
            // Nothing was written to the Runner, so there is nothing to mark.
            await this.#submitCompletion(
              snapshot.runFriendlyId,
              snapshot.snapshotFriendlyId,
              requested
            );
            return;
          }
          const outcome = await runnerSnapshotter.awaitSuspend(target);
          if (!outcome.ok) {
            setExtra(fromContext(), "snapshot.error", outcome.error);
          }
          await this.#deliverSuspend(runnerSnapshotter, snapshot, outcome);
        } finally {
          this.suspendsInFlight.delete(key);
        }
      }
    );
  }
}

function suspendKey(target: { runnerId: string; snapshotFriendlyId: string }): string {
  return `${target.runnerId}/${target.snapshotFriendlyId}`;
}
