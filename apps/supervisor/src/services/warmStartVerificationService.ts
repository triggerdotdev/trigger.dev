import pLimit from "p-limit";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { tryCatch } from "@trigger.dev/core";
import { TimerWheel } from "./timerWheel.js";
import { emitOneShot, type WideEventOptions } from "../wideEvents/index.js";

const PROBE_CONCURRENCY_LIMIT = 10;

export type WarmStartTimings = {
  dequeueResponseMs?: number;
  pollingIntervalMs?: number;
  warmStartCheckMs: number;
};

type PendingVerification = {
  message: DequeuedMessage;
  timings: WarmStartTimings;
};

export type WarmStartVerificationServiceOptions = {
  workerClient: SupervisorHttpClient;
  /** How long after a warm-start hit to verify the runner acted on it. */
  delayMs: number;
  /** Cold-creates the workload for a dispatched-but-lost run. */
  createWorkload: (message: DequeuedMessage, timings: WarmStartTimings) => Promise<void>;
  wideEventOpts: WideEventOptions;
};

/**
 * Verifies that warm-start dispatches were actually acted on.
 *
 * Firestarter's `didWarmStart: true` means "response written to a socket",
 * not "runner received it". A silently dead poller (no FIN - e.g. a VM torn
 * down mid-poll) leaves the dispatched run stuck in PENDING_EXECUTING until
 * the run engine's heartbeat redrive minutes later, burning a queue
 * redelivery each time (TRI-10659).
 *
 * After a hit, the dequeued message is retained for `delayMs`, then the
 * platform is asked for the run's latest snapshot. If it is still the exact
 * snapshot we dequeued, no runner ever started the attempt - fall through to
 * the regular cold-create path with the original message. Double-starts are
 * impossible: `startRunAttempt` runs under a per-run lock and rejects stale
 * snapshot ids, so if the original runner revives and races the fallback
 * workload, exactly one wins and the loser exits before executing anything.
 *
 * On a probe ERROR we deliberately do nothing: the runner's attempt-start
 * goes through nested retries, so during platform brownouts a healthy runner
 * can legitimately act late - falling back on uncertainty would stampede
 * duplicate workloads exactly when the platform is degraded. The heartbeat
 * redrive remains the backstop for that case (and for supervisor restarts,
 * which drop the in-memory timers).
 */
export class WarmStartVerificationService {
  private readonly logger = new SimpleStructuredLogger("warm-start-verification");

  private readonly timerWheel: TimerWheel<PendingVerification>;
  private readonly probeLimit: ReturnType<typeof pLimit>;

  private readonly workerClient: SupervisorHttpClient;
  private readonly delayMs: number;
  private readonly createWorkload: WarmStartVerificationServiceOptions["createWorkload"];
  private readonly wideEventOpts: WideEventOptions;

  constructor(opts: WarmStartVerificationServiceOptions) {
    this.workerClient = opts.workerClient;
    this.delayMs = opts.delayMs;
    this.createWorkload = opts.createWorkload;
    this.wideEventOpts = opts.wideEventOpts;

    this.probeLimit = pLimit(PROBE_CONCURRENCY_LIMIT);
    this.timerWheel = new TimerWheel<PendingVerification>({
      delayMs: opts.delayMs,
      onExpire: (item) => {
        this.probeLimit(() => this.verify(item.data)).catch((error) => {
          this.logger.error("Verification failed", {
            runId: item.data.message.run.friendlyId,
            error,
          });
        });
      },
    });
    this.timerWheel.start();
  }

  /** Schedule delivery verification for a warm-start hit. */
  schedule(message: DequeuedMessage, timings: WarmStartTimings) {
    this.timerWheel.submit(message.run.friendlyId, { message, timings });
    this.logger.debug("Verification scheduled", {
      runId: message.run.friendlyId,
      snapshotId: message.snapshot.friendlyId,
      delayMs: this.delayMs,
    });
  }

  /**
   * Cancel a pending verification, e.g. when the runner connects to this
   * supervisor. Purely an optimization: the matched runner often lives on a
   * different node and connects to that node's supervisor, so most healthy
   * deliveries are confirmed by the probe, not by this.
   */
  cancel(runFriendlyId: string): boolean {
    return this.timerWheel.cancel(runFriendlyId);
  }

  /** Stop the timer wheel, dropping pending verifications. The run engine's
   * heartbeat redrive covers anything dropped here. */
  stop() {
    const remaining = this.timerWheel.stop();
    if (remaining.length > 0) {
      this.logger.info("Stopped, dropped pending verifications", { count: remaining.length });
    }
  }

  private async verify({ message, timings }: PendingVerification) {
    const runFriendlyId = message.run.friendlyId;

    const result = await this.workerClient.getLatestSnapshot(runFriendlyId);

    if (!result.success) {
      // Never fall back on uncertainty - see class docs.
      this.emitOutcome(message, "probe_error", String(result.error));
      this.logger.warn("Verification probe failed, skipping", {
        runId: runFriendlyId,
        error: result.error,
      });
      return;
    }

    const latestSnapshotId = result.data.execution.snapshot.friendlyId;

    if (latestSnapshotId !== message.snapshot.friendlyId) {
      // Something acted on the run (attempt started, or it was cancelled or
      // requeued) - the dispatch is no longer ours to worry about.
      this.emitOutcome(message, "delivered");
      return;
    }

    this.emitOutcome(message, "fallback");
    this.logger.warn("Warm start dispatch was never acted on, cold starting", {
      runId: runFriendlyId,
      snapshotId: message.snapshot.friendlyId,
    });

    const [error] = await tryCatch(this.createWorkload(message, timings));
    if (error) {
      this.logger.error("Fallback workload create failed", {
        runId: runFriendlyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitOutcome(
    message: DequeuedMessage,
    outcome: "delivered" | "fallback" | "probe_error",
    error?: string
  ) {
    emitOneShot({
      ...this.wideEventOpts,
      op: "warmstart.verify",
      kind: "event",
      populate: (state) => {
        state.meta.run_id = message.run.friendlyId;
        state.meta.snapshot_id = message.snapshot.friendlyId;
        state.extras.outcome = outcome;
        state.extras.delay_ms = this.delayMs;
        if (error) state.extras.error = error;
      },
    });
  }
}
