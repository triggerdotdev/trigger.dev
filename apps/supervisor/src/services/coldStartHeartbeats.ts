import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { Counter, Gauge, type Registry } from "prom-client";
import { withTimeout } from "../clients/kubernetes.js";
import type { ColdStartState } from "../workloadManager/runCrd.js";

/** The dequeued snapshot a cold start is for, and the Runner created for it. */
export type ColdStartTarget = {
  runFriendlyId: string;
  snapshotFriendlyId: string;
  runnerId: string;
};

/** `rejected` is a heartbeat the platform refused, which a retry will not change. */
export type ColdStartBeatResult = "ok" | "rejected" | "failed";

type ColdStartHeartbeatsOptions = {
  readState: (target: ColdStartTarget) => Promise<ColdStartState>;
  heartbeat: (target: ColdStartTarget) => Promise<ColdStartBeatResult>;
  intervalMs: number;
  /** The most a cold start is heartbeated for, however long its Runner takes to start. */
  timeoutMs: number;
  register: Registry;
};

/** Returned by `start`, for the create to say how it went. */
export type ColdStartHeartbeat = {
  created: () => void;
  createFailed: () => void;
};

type EndReason =
  | "started"
  | "runner_failed"
  | "runner_gone"
  | "superseded"
  | "rejected"
  | "create_failed"
  | "connected"
  | "timeout"
  | "replaced"
  | "shutdown";

const ENDED_BY: Record<ColdStartState, EndReason | undefined> = {
  starting: undefined,
  started: "started",
  failed: "runner_failed",
  gone: "runner_gone",
  superseded: "superseded",
};

type Entry = {
  target: ColdStartTarget;
  created: boolean;
  deadline: number;
  timer?: NodeJS.Timeout;
  /** A tick's read and beat are still running. */
  busy: boolean;
  /** The Runner read still in flight, which the client cannot cancel. */
  reading?: Promise<ColdStartState>;
};

/**
 * A 4xx other than a timeout or a rate limit: the platform refused this heartbeat,
 * for example as the run moved on from the snapshot, and will refuse the next.
 */
export function heartbeatRejected(statusCode: number | undefined): boolean {
  return (
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 429
  );
}

/**
 * Heartbeats a cold start's dequeued snapshot from its create until its runner
 * takes over, so a Runner that waits for a node is not taken for a stalled run
 * and requeued. The restore watch does the same for resumes.
 *
 * One timer per cold start, keyed by run: a later delivery of the run replaces
 * the earlier one. Each tick schedules the next one first, then reads the Runner
 * and beats. The read waits at most half an interval, so a hung read delays a
 * beat by at most that and never holds back a later tick or the limit.
 * A tick whose predecessor is still at work does nothing, and a read the client
 * could not cancel is waited on again rather than repeated.
 */
export class ColdStartHeartbeats {
  private readonly logger = new SimpleStructuredLogger("cold-start-heartbeats");
  private readonly opts: ColdStartHeartbeatsOptions;
  private readonly entries = new Map<string, Entry>();
  private stopped = false;

  private readonly inFlight: Gauge;
  private readonly endedTotal: Counter;

  constructor(opts: ColdStartHeartbeatsOptions) {
    this.opts = opts;
    this.inFlight = new Gauge({
      name: "supervisor_cold_start_heartbeats_in_flight",
      help: "Cold starts the supervisor heartbeats until their runner takes over.",
      registers: [opts.register],
    });
    this.endedTotal = new Counter({
      name: "supervisor_cold_start_heartbeats_ended_total",
      help: "Cold start heartbeats ended, by reason.",
      labelNames: ["reason"],
      registers: [opts.register],
    });
  }

  /** Call as the create is issued. The Runner is only read once the create says it exists. */
  start(target: ColdStartTarget): ColdStartHeartbeat {
    if (this.stopped) {
      return { created: () => {}, createFailed: () => {} };
    }
    this.end(target.runFriendlyId, "replaced");
    const entry = this.add(target, false, Date.now() + this.opts.timeoutMs);
    this.schedule(entry, this.opts.intervalMs);
    return {
      created: () => {
        entry.created = true;
      },
      createFailed: () => this.endEntry(entry, "create_failed"),
    };
  }

  /**
   * Takes over a cold start found still starting after a restart, whose heartbeat went
   * with the earlier process. It beats at once, and its limit counts from the Runner's
   * creation. A run this process already heartbeats is left alone.
   */
  adopt(target: ColdStartTarget, createdAt: Date) {
    const deadline = createdAt.getTime() + this.opts.timeoutMs;
    if (this.stopped || this.entries.has(target.runFriendlyId) || Date.now() >= deadline) {
      return;
    }
    this.schedule(this.add(target, true, deadline), 0);
  }

  /** The run's runner connected to this process, so its own heartbeats take over. */
  runnerConnected(runFriendlyId: string) {
    this.end(runFriendlyId, "connected");
  }

  stop() {
    this.stopped = true;
    for (const entry of [...this.entries.values()]) {
      this.endEntry(entry, "shutdown");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private add(target: ColdStartTarget, created: boolean, deadline: number): Entry {
    const entry: Entry = { target, created, deadline, busy: false };
    this.entries.set(target.runFriendlyId, entry);
    this.inFlight.inc();
    return entry;
  }

  private schedule(entry: Entry, delayMs: number) {
    const delay = Math.min(delayMs, Math.max(0, entry.deadline - Date.now()));
    entry.timer = setTimeout(() => void this.tick(entry), delay);
  }

  private async tick(entry: Entry) {
    entry.timer = undefined;
    if (!this.isCurrent(entry)) {
      return;
    }
    if (Date.now() >= entry.deadline) {
      this.logger.warn("Cold start heartbeat stopped at its limit, the runner never took over", {
        runFriendlyId: entry.target.runFriendlyId,
        runnerId: entry.target.runnerId,
        timeoutMs: this.opts.timeoutMs,
      });
      this.endEntry(entry, "timeout");
      return;
    }
    this.schedule(entry, this.opts.intervalMs);
    if (entry.busy) {
      return;
    }
    entry.busy = true;
    try {
      await this.readAndBeat(entry);
    } finally {
      entry.busy = false;
    }
  }

  private async readAndBeat(entry: Entry) {
    if (entry.created) {
      const ended = ENDED_BY[(await this.readState(entry)) ?? "starting"];
      if (ended) {
        this.endEntry(entry, ended);
        return;
      }
    }
    if (!this.isCurrent(entry)) {
      return;
    }
    let result: ColdStartBeatResult;
    try {
      result = await this.opts.heartbeat(entry.target);
    } catch (error) {
      this.logger.warn("Cold start heartbeat failed", {
        runFriendlyId: entry.target.runFriendlyId,
        error,
      });
      result = "failed";
    }
    if (!this.isCurrent(entry)) {
      return;
    }
    if (result === "rejected") {
      this.endEntry(entry, "rejected");
    }
  }

  /** Undefined when the read failed or is too slow: the beat goes ahead either way. */
  private async readState(entry: Entry): Promise<ColdStartState | undefined> {
    entry.reading ??= this.opts.readState(entry.target).finally(() => {
      entry.reading = undefined;
    });
    try {
      return await withTimeout(entry.reading, this.opts.intervalMs / 2, "Cold start Runner read");
    } catch (error) {
      // A read outage longer than the stall timeout would otherwise requeue a healthy start.
      this.logger.warn("Cold start Runner read failed", {
        runFriendlyId: entry.target.runFriendlyId,
        runnerId: entry.target.runnerId,
        error,
      });
      return undefined;
    }
  }

  private isCurrent(entry: Entry): boolean {
    return this.entries.get(entry.target.runFriendlyId) === entry;
  }

  private end(runFriendlyId: string, reason: EndReason) {
    const entry = this.entries.get(runFriendlyId);
    if (entry) {
      this.endEntry(entry, reason);
    }
  }

  private endEntry(entry: Entry, reason: EndReason) {
    if (!this.isCurrent(entry)) {
      return;
    }
    clearTimeout(entry.timer);
    entry.timer = undefined;
    this.entries.delete(entry.target.runFriendlyId);
    this.inFlight.dec();
    this.endedTotal.inc({ reason });
    this.logger.debug("Cold start heartbeat ended", {
      runFriendlyId: entry.target.runFriendlyId,
      runnerId: entry.target.runnerId,
      reason,
    });
  }
}
