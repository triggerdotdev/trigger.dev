/**
 * The reader contract every watch condition family shares, plus the duration formatting
 * they all label with. No IO of its own.
 */

import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import type { WatchCheckResult, WatchObservedOutcome } from "@internal/dashboard-agent-contracts";

/** The single run point-read. Postgres is authoritative for run state. */
export type WatchRunRow = {
  friendlyId: string;
  status: string;
  queue: string;
  createdAt: Date;
  /** Stamped when the run entered the queue. NULL while a run is delayed. */
  queuedAt: Date | null;
  /** Set once the run is dequeued. */
  startedAt: Date | null;
  completedAt: Date | null;
  delayUntil: Date | null;
};

export type WatchQueueDepth = {
  /** Pending count for the queue, as of `asOf`. */
  depth: number;
  source: "live_queue" | "queue_metrics";
  /** A stale reading can never answer "drained". */
  current: boolean;
  /** What instant the reading describes, when it isn't the live counter. */
  asOf?: Date;
};

/**
 * The oldest still-waiting run's age in one queue. A non-current age is wrong in both
 * directions, so `checkQueueOldestAge` refuses it rather than comparing it.
 */
export type WatchQueueOldestAge = {
  /** Age of the oldest run still waiting, in ms. Null when nothing is waiting. */
  ageMs: number | null;
  source: "live_queue" | "queue_metrics";
  current: boolean;
  asOf?: Date;
};

/** What we know about the watched error's occurrences relative to `since`. */
export type WatchErrorRecurrence = {
  /** Earliest occurrence proven after `since`. Null with a `lastSeenAt` means not since. */
  occurredAt: Date | null;
  /** How precisely `occurredAt` is known: to the millisecond, or to its minute. */
  occurredAtPrecision: "exact" | "minute" | null;
  /** Occurrences after `since`. A lower bound when `countApproximate`. */
  countSince: number;
  /** True when occurrences in the watch's creation minute can't be separated out. */
  countApproximate: boolean;
  /** The fingerprint's most recent occurrence, whenever it was. */
  lastSeenAt: Date | null;
};

export type WatchHealthSeverity = "ok" | "warn" | "crit";

export type WatchHealthSnapshot = {
  /** `facts.trustworthy` from the health report. Untrustworthy never fires recovery. */
  trustworthy: boolean;
  severity: WatchHealthSeverity;
};

/**
 * The readers a check may use. Each may throw, which the caller turns into `unavailable`.
 * `null` means the source answered and there is nothing there.
 */
export type WatchCheckDeps = {
  /** Run point-read by public run id, scoped to the watch's environment. */
  readRun: (runId: string) => Promise<WatchRunRow | null>;
  /** Does this queue exist in the watch's environment? */
  queueExists: (queue: string) => Promise<boolean>;
  /** Current pending count, live run-queue first with a ClickHouse fallback. */
  readQueueDepth: (queue: string) => Promise<WatchQueueDepth | null>;
  /** Age of the oldest run still waiting in the queue, right now. */
  readQueueOldestAge: (queue: string) => Promise<WatchQueueOldestAge | null>;
  /** `null` means the fingerprint has no occurrences at all in this environment. */
  readErrorRecurrence: (fingerprint: string, since: Date) => Promise<WatchErrorRecurrence | null>;
  /** The health report's current verdict for the watch's environment. */
  readHealth: () => Promise<WatchHealthSnapshot | null>;
};

export type WatchCheckInput = {
  now: Date;
  /** The recurrence window's start: the server-set `spec.since`, never caller-set. */
  since: Date;
  /**
   * The previous check's facts, for the stateful kinds. A check's own facts are the only
   * storage for its state. Absent means no prior observation, never zero.
   */
  previous?: Record<string, unknown> | null;
};

export type WatchCheckOutcome = {
  result: WatchCheckResult;
  facts: Record<string, unknown>;
  /** Frozen onto the row by the resolving transition, so no surface re-reads the source. */
  observed: WatchObservedOutcome;
};

export function formatMs(ms: number): string {
  return formatDurationMilliseconds(ms, { style: "short", maxDecimalPoints: 0 });
}
