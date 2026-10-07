import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import {
  restoreHeartbeat,
  type RestoreRunner,
  type RestoreWatchResult,
  type RunnerPhaseListener,
} from "../workloadManager/runCrd.js";

/** The dequeued snapshot a restore is for. */
type RestoreWatchTarget = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
};

/** A failed restore, with what the watch or the Runner knew of its run. */
export type RestoreFailure = {
  runFriendlyId?: string;
  snapshotFriendlyId?: string;
  runnerId: string;
  outcome: RestoreWatchResult & { ok: false };
};

type RestoreWatcherOptions = {
  awaitRestore: (
    restore: RestoreRunner,
    onPhase: RunnerPhaseListener,
    signal: AbortSignal
  ) => Promise<RestoreWatchResult>;
  heartbeat: (beat: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    runnerId: string;
  }) => Promise<void>;
  heartbeatIntervalMs: number;
  reportFailure: (failure: RestoreFailure) => Promise<void>;
  register: Registry;
};

/** `uid` is the Runner the watch is bound to; `abort` ends a watch a newer Runner replaced. */
type WatchedRestore = RestoreWatchTarget & { uid?: string; abort: AbortController };

/**
 * Watches restore Runners until they start or fail, and reports the failures. A
 * resume that fails on the node is otherwise silent until the run's heartbeat stalls.
 */
export class RestoreWatcher {
  private readonly logger = new SimpleStructuredLogger("restore-watcher");
  private readonly opts: RestoreWatcherOptions;
  /** Restore Runners being watched, each with the latest snapshot dequeued for it. */
  private readonly watches = new Map<string, WatchedRestore>();
  private readonly reports = new Set<Promise<void>>();
  private stopped = false;

  private readonly watchesInFlight: Gauge;
  private readonly outcomesTotal: Counter;
  private readonly duration: Histogram;

  constructor(opts: RestoreWatcherOptions) {
    this.opts = opts;
    this.watchesInFlight = new Gauge({
      name: "supervisor_restore_watches_in_flight",
      help: "Restore Runners the supervisor is waiting on to start or fail.",
      registers: [opts.register],
    });
    this.outcomesTotal = new Counter({
      name: "supervisor_restore_outcomes_total",
      help: "Restore watches ended, by outcome and reason: the operator's failure reason, or Timeout, RunnerGone or ReadFailed from the watch itself.",
      labelNames: ["outcome", "reason"],
      registers: [opts.register],
    });
    this.duration = new Histogram({
      name: "supervisor_restore_duration_seconds",
      help: "Time from a restore Runner's creation to the supervisor seeing it Running or Failed.",
      labelNames: ["outcome"],
      buckets: [1, 2.5, 5, 10, 20, 30, 60, 120, 300, 600, 900],
      registers: [opts.register],
    });
  }

  async watch(target: RestoreWatchTarget, restore: RestoreRunner): Promise<void> {
    // The next process's first list adopts a restore this one no longer watches.
    if (this.stopped) {
      return;
    }
    const { runnerId, uid } = restore;
    const { runFriendlyId } = target;
    // A redelivered restore finds the same Runner, which needs only one watch,
    // but its beats and report must name the snapshot dequeued last.
    const watched = this.watches.get(runnerId);
    if (watched && (watched.uid === undefined || uid === undefined || watched.uid === uid)) {
      watched.snapshotFriendlyId = target.snapshotFriendlyId;
      return;
    }
    // The redelivery replaced the Runner, so the watch on the old one has nothing left to say.
    watched?.abort.abort();
    const entry: WatchedRestore = { ...target, uid, abort: new AbortController() };
    this.watches.set(runnerId, entry);
    this.watchesInFlight.inc();
    const heartbeat = restoreHeartbeat(
      () =>
        this.opts.heartbeat({
          runFriendlyId,
          snapshotFriendlyId: entry.snapshotFriendlyId,
          runnerId,
        }),
      this.opts.heartbeatIntervalMs
    );
    const outcome = await this.opts
      .awaitRestore(restore, heartbeat.onPhase, entry.abort.signal)
      .finally(() => {
        heartbeat.stop();
        this.watchesInFlight.dec();
        if (this.watches.get(runnerId) === entry) {
          this.watches.delete(runnerId);
        }
      });
    if (entry.abort.signal.aborted) {
      return;
    }
    const outcomeLabel = outcome.ok ? "started" : "failed";
    this.outcomesTotal.inc({
      outcome: outcomeLabel,
      reason: outcome.ok ? "Started" : outcome.reason,
    });
    if (outcome.createdAt) {
      this.duration.observe(
        { outcome: outcomeLabel },
        (Date.now() - outcome.createdAt.getTime()) / 1000
      );
    }
    if (outcome.ok) {
      this.logger.debug("Runner restore started", { runFriendlyId, runnerId });
      return;
    }
    await this.report({
      runFriendlyId,
      snapshotFriendlyId: entry.snapshotFriendlyId,
      runnerId,
      outcome,
    });
  }

  /**
   * Tracked, so a shutdown can let a report already under way finish. Refused once
   * stopping: a report the exit cut short could delete the Runner unreported, and
   * one never started leaves it for the next process to find and report.
   */
  report(failure: RestoreFailure): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    const report = this.opts.reportFailure(failure).finally(() => this.reports.delete(report));
    this.reports.add(report);
    return report;
  }

  /**
   * Ends every watch without reporting it and refuses new ones: a watch cut short
   * knows nothing about its restore. Waits for the reports already under way.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const watched of this.watches.values()) {
      watched.abort.abort();
    }
    await Promise.allSettled([...this.reports]);
  }
}
