import { formatNumber } from "~/utils/numberFormatter";
import {
  EMERGENCY_CAP_NOTICE,
  isRunStarting,
  RUN_STARTING_WINDOW_MS,
  unavailableReasonText,
  type RunLoadBlock,
} from "./sessionRunFallback";
import type { SessionRunLoad } from "./sessionRunLoads";
import type { SessionTraceRun } from "./sessionTraceTypes";
import { runStartedBecause } from "./sessionTraceView";

type UnavailableReason = Extract<RunLoadBlock, { kind: "unavailable" }>["reason"];

/**
 * What the runs route says about a run. The panel works out its note from these facts and the
 * clock, so nothing it shows can go stale: no "starting" is ever stored.
 */
export type RunFacts = Pick<SessionTraceRun, "number" | "reason" | "afterCrash" | "triggeredAt"> & {
  /** Why it can't load here, known before any read (the runs route's `view.unavailable`). */
  unavailable: UnavailableReason | "logsDeleted" | undefined;
};

export function runFactsOf(
  run: Pick<SessionTraceRun, "number" | "reason" | "afterCrash" | "triggeredAt">,
  view: { unavailable?: RunFacts["unavailable"] } | undefined
): RunFacts {
  return {
    number: run.number,
    reason: run.reason,
    afterCrash: run.afterCrash,
    triggeredAt: run.triggeredAt,
    unavailable: view?.unavailable,
  };
}

/** What reading the run's trace in the Trace tab found: only the tab knows these. */
export type RunLoadNote =
  | { kind: "logsDeleted" }
  | { kind: "unavailable"; reason: UnavailableReason }
  | { kind: "cutOff"; started: boolean; limit: "run" | "session"; spanLimit: number }
  | { kind: "error"; message: string };

/** Why a run's spans aren't shown in the Trace tab, for its panel note. */
export type RunNotShown = RunLoadNote | { kind: "starting" } | { kind: "neverStarted" };

export function runLoadNote(load: SessionRunLoad): RunLoadNote | undefined {
  switch (load.state) {
    case "logsDeleted":
      return { kind: "logsDeleted" };
    case "unavailable":
      return { kind: "unavailable", reason: load.reason };
    case "cutOff":
      return {
        kind: "cutOff",
        started: load.started,
        limit: load.limit,
        spanLimit: load.spanLimit,
      };
    case "error":
      return { kind: "error", message: load.message };
    default:
      return undefined;
  }
}

/**
 * The note, from facts: a run without a span id isn't in the run store, so it's starting for 5
 * minutes after it was triggered and never started after that; otherwise what the runs route
 * said, then what the tab's read found.
 */
export function runNotShown({
  facts,
  inRunStore,
  loadNote,
  nowMs,
}: {
  facts: RunFacts | undefined;
  inRunStore: boolean;
  loadNote: RunLoadNote | undefined;
  nowMs: number;
}): RunNotShown | undefined {
  if (!inRunStore) {
    if (!facts) return undefined;
    return isRunStarting(facts, nowMs) ? { kind: "starting" } : { kind: "neverStarted" };
  }
  if (facts?.unavailable === "logsDeleted") return { kind: "logsDeleted" };
  if (facts?.unavailable) return { kind: "unavailable", reason: facts.unavailable };
  return loadNote;
}

/**
 * A linked span the Trace tab never showed: only once its run's read has ended (not while it
 * pages, since a later page can bring it) and only on the Trace tab. The run's own span has no
 * row (the run row stands for it), and the run panel already shows it.
 */
export function spanNotLoaded({
  spanId,
  runSpanId,
  spanSeen,
  runSettled,
  onTraceTab,
}: {
  spanId: string | undefined;
  runSpanId: string | undefined;
  spanSeen: boolean;
  runSettled: boolean;
  onTraceTab: boolean;
}): boolean {
  if (spanId === undefined || spanId === runSpanId) return false;
  return !spanSeen && runSettled && onTraceTab;
}

/** When a starting run's note turns into "never started", so the panel can re-render then. */
export function startingEndsAtMs(facts: RunFacts) {
  return new Date(facts.triggeredAt).getTime() + RUN_STARTING_WINDOW_MS;
}

/** The panel always links to the run page, apart from a run that never started. */
export function panelLinksToRunPage(notShown: RunNotShown | undefined) {
  return notShown?.kind !== "neverStarted";
}

export function startedBecauseText(info: Pick<RunFacts, "number" | "reason" | "afterCrash">) {
  return `Run ${info.number} · Started because: ${runStartedBecause(info)}`;
}

export function notShownText(notShown: RunNotShown): string {
  switch (notShown.kind) {
    case "starting":
      return "This run hasn't started yet. Its spans show here once it does.";
    case "neverStarted":
      return "This run never started, so it has no run page or spans.";
    case "logsDeleted":
      return "Logs deleted under this plan's retention, so its spans can't be shown.";
    case "unavailable":
      return notShown.reason === "emergencyCap"
        ? EMERGENCY_CAP_NOTICE
        : `Can't show its spans here. ${unavailableReasonText(notShown.reason)}`;
    case "cutOff": {
      const limit = formatNumber(notShown.spanLimit);
      if (notShown.limit === "run")
        return `Partly loaded: stopped at this run's limit of ${limit} spans.`;
      return notShown.started
        ? `Partly loaded: stopped at ${limit} spans across this session.`
        : `Not loaded: it would pass the limit of ${limit} spans across this session. Collapse other runs, then expand it again.`;
    }
    case "error":
      return `Couldn't load its spans (${notShown.message}). Retry from its row.`;
  }
}
