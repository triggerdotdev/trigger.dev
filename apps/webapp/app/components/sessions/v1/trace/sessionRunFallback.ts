import type { SessionRunsPage } from "~/presenters/v3/SessionRunsPresenter.server";
import type { RunTraceStart } from "~/presenters/v3/TraceChunkPresenter.server";
import type { SessionRunLoad } from "./sessionRunLoads";
import type { SessionTraceRun } from "./sessionTraceTypes";

type UnavailableReason = Extract<RunTraceStart, { kind: "unavailable" }>["reason"];
type RunView = SessionRunsPage["view"][string] | undefined;

/** Why a run's trace can't load in this view, from before a read or from its first chunk. */
export type RunLoadBlock =
  | { kind: "notInRunStore" }
  | { kind: "logsDeleted" }
  | { kind: "unavailable"; reason: UnavailableReason };

/** A run missing from the run store this long after it was triggered isn't coming. */
export const RUN_STARTING_WINDOW_MS = 5 * 60 * 1000;

export function runLoadBlock(
  run: Pick<SessionTraceRun, "status">,
  view: RunView,
  load: SessionRunLoad
): RunLoadBlock | undefined {
  if (!run.status) return { kind: "notInRunStore" };
  const before = view?.unavailable;
  if (before === "logsDeleted" || load.state === "logsDeleted") return { kind: "logsDeleted" };
  if (before) return { kind: "unavailable", reason: before };
  if (load.state === "unavailable") return { kind: "unavailable", reason: load.reason };
  return undefined;
}

/** Runs the session runs route already says can't load: they're never queued. */
export function runsUnavailableBeforeRead(view: SessionRunsPage["view"]): string[] {
  return Object.entries(view).flatMap(([id, entry]) => (entry.unavailable ? [id] : []));
}

/** A run not in the run store yet: "starting" while it's new, then given up on. */
export function isRunStarting(run: Pick<SessionTraceRun, "triggeredAt">, nowMs: number) {
  return nowMs - new Date(run.triggeredAt).getTime() < RUN_STARTING_WINDOW_MS;
}

const UNAVAILABLE_REASONS: Record<UnavailableReason, string | undefined> = {
  legacyStore: "This run's spans are in an older store this view can't read.",
  // Said once in the tab's bar instead.
  emergencyCap: undefined,
  chunkUnsupported: "This run's spans are stored in a way this view can't read in parts.",
  noWriteTimes: "This run's spans are missing the details this view needs to read them in parts.",
  anchorMissing: "The start of this run's trace is missing.",
  noSpans: "This run didn't record any spans.",
};

export function unavailableReasonText(reason: UnavailableReason) {
  return UNAVAILABLE_REASONS[reason];
}

export const EMERGENCY_CAP_NOTICE =
  "Traces can't load here right now. Open a run's page to see its trace.";

/** One line in the tab's bar; the reason or what to do goes in `hint`, shown on hover. */
export type BarNotice = { text: string; hint?: string; onRetry?: () => void };

export const SESSION_LIMIT_NOTICE: BarNotice = {
  text: "Session span limit reached",
  hint: "Collapse runs to load more.",
};

/**
 * The bar has room for one notice, so the most specific wins: a deep link that didn't load, then
 * the emergency cap (from the runs route or any run's first chunk), then the session span limit.
 */
export function sessionBarNotice({
  deepLink,
  view,
  loads,
}: {
  deepLink: BarNotice | undefined;
  view: Readonly<Record<string, { unavailable?: string }>>;
  loads: Readonly<Record<string, SessionRunLoad>>;
}): BarNotice | undefined {
  if (deepLink) return deepLink;
  const runLoads = Object.values(loads);
  const capped =
    Object.values(view).some((entry) => entry.unavailable === "emergencyCap") ||
    runLoads.some((load) => load.state === "unavailable" && load.reason === "emergencyCap");
  if (capped) return { text: EMERGENCY_CAP_NOTICE };
  if (runLoads.some((load) => load.state === "cutOff" && load.limit === "session")) {
    return SESSION_LIMIT_NOTICE;
  }
  return undefined;
}
