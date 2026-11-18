import type { SessionTraceRun } from "./sessionTraceTypes";

export type SessionPageView = "trace" | "conversation";

/** Cookie the Trace tab's tree/timeline split is saved under; the session loader reads it. */
export const SESSION_TREE_AUTOSAVE_ID = "panel-session-tree";

/**
 * Which left-hand tab the session page shows. Trace is the default when the feature is on;
 * links to the conversation's Raw view or a channel still open the conversation.
 */
export function resolveSessionPageView({
  view,
  raw,
  channel,
  traceEnabled,
}: {
  view: string | undefined;
  raw: string | undefined;
  channel: string | undefined;
  traceEnabled: boolean;
}): SessionPageView {
  if (!traceEnabled) return "conversation";
  if (view === "trace" || view === "conversation") return view;
  if (raw === "1" || channel) return "conversation";
  return "trace";
}

// Maps, not objects: a custom reason can be any string, "toString" included.
const REASON_LABELS = new Map<string, string>([
  ["initial", "first run"],
  ["continuation", "continued after the previous run ended"],
  ["upgrade", "moved to a new version"],
  ["manual", "started manually"],
]);

/** Why the run started, for "Started because: …". Custom reasons from end-and-continue show as sent. */
export function runStartedBecause(run: Pick<SessionTraceRun, "reason" | "afterCrash">) {
  if (run.afterCrash) return "restarted after the previous run crashed";
  return REASON_LABELS.get(run.reason) ?? run.reason;
}

export type RunReasonBadge = { label: string; tone: "warning" | "neutral"; tooltip?: string };

const BADGE_LABELS = new Map<string, string | undefined>([
  ["initial", undefined],
  ["continuation", undefined],
  ["upgrade", "New version"],
  ["manual", "Started manually"],
]);

/** A badge on the run's row only when its start reason is worth noticing. */
export function runReasonBadge(
  run: Pick<SessionTraceRun, "reason" | "afterCrash">
): RunReasonBadge | undefined {
  if (run.afterCrash) return { label: "Crash restart", tone: "warning" };
  if (BADGE_LABELS.has(run.reason)) {
    const label = BADGE_LABELS.get(run.reason);
    return label ? { label, tone: "neutral" } : undefined;
  }
  return { label: run.reason, tone: "neutral", tooltip: run.reason };
}
