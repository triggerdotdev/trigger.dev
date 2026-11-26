import type { TaskRunStatus } from "@trigger.dev/database";
import type { SessionRunsSessionFacts } from "~/presenters/v3/SessionRunsPresenter.server";
import type { SessionHandover } from "./sessionHandoverData";

/** The Runs tab shows this many; "View all runs" covers the rest. */
export const SESSION_DETAILS_RUNS = 50;

export type SessionRunEntry = {
  /** React key: the SessionRun id from the page load, else the run's friendlyId. */
  id: string;
  runFriendlyId: string;
  reason: string;
  triggeredAt: string;
  run: { friendlyId: string; status: TaskRunStatus; version?: string | null } | null;
  /** Set when this run continued a reply the previous run handed over mid-turn. */
  handover?: SessionHandover;
};

/** What the session details show that can change while the page is open. */
export type SessionDetailsData = {
  closedAt?: string;
  closedReason?: string;
  expiresAt?: string;
  updatedAt: string;
  currentRun: {
    friendlyId: string;
    status: TaskRunStatus | null;
    version?: string | null;
  } | null;
  runs: SessionRunEntry[];
};

export type PolledSessionRun = {
  friendlyId: string;
  reason: string;
  triggeredAt: string;
  status: TaskRunStatus | null;
};

/** The Trace tab's last read of the session and its runs. */
export type SessionRead = {
  facts: SessionRunsSessionFacts;
  runs: readonly PolledSessionRun[];
};

/**
 * The newer of the page load and the Trace tab's last read, by the session row's `updatedAt`
 * (closing and each new run bump it). The page load re-runs after Close session, so an older
 * read must not win; on a tie the read wins, as it may have newer run statuses.
 */
export function currentSessionDetails(
  loaded: SessionDetailsData,
  read: SessionRead | undefined
): SessionDetailsData {
  if (!read || Date.parse(read.facts.updatedAt) < Date.parse(loaded.updatedAt)) return loaded;

  const { facts } = read;
  const runs = mergeSessionRunEntries(loaded.runs, read.runs);
  return {
    closedAt: facts.closedAt ?? undefined,
    closedReason: facts.closedReason ?? undefined,
    expiresAt: facts.expiresAt ?? undefined,
    updatedAt: facts.updatedAt,
    currentRun: currentRunOf(facts.currentRunFriendlyId, runs, loaded.currentRun),
    runs,
  };
}

/** Page-load runs plus polled ones, by run: the polled read wins, newest first, capped. */
export function mergeSessionRunEntries(
  loaded: readonly SessionRunEntry[],
  polled: readonly PolledSessionRun[]
): SessionRunEntry[] {
  const byRun = new Map<string, SessionRunEntry>();
  for (const entry of loaded) byRun.set(entry.runFriendlyId, entry);
  for (const run of polled) {
    const previous = byRun.get(run.friendlyId);
    byRun.set(run.friendlyId, {
      id: previous?.id ?? run.friendlyId,
      runFriendlyId: run.friendlyId,
      reason: run.reason,
      triggeredAt: run.triggeredAt,
      // The runs route drops runs outside the session's environment; keep what the page load had.
      run: run.status
        ? { friendlyId: run.friendlyId, status: run.status, version: previous?.run?.version }
        : (previous?.run ?? null),
      handover: previous?.handover,
    });
  }
  return [...byRun.values()]
    .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
    .slice(0, SESSION_DETAILS_RUNS);
}

function currentRunOf(
  friendlyId: string | null,
  runs: readonly SessionRunEntry[],
  loaded: SessionDetailsData["currentRun"]
): SessionDetailsData["currentRun"] {
  if (!friendlyId) return null;
  const run = runs.find((entry) => entry.runFriendlyId === friendlyId)?.run;
  const sameAsLoaded = loaded?.friendlyId === friendlyId;
  const status = run?.status ?? (sameAsLoaded ? loaded.status : null);
  const version = run?.version ?? (sameAsLoaded ? loaded.version : undefined);
  return { friendlyId, status, version };
}
