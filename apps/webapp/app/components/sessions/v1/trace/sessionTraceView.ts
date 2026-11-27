import { SKEW_THRESHOLD_RUN_REASON } from "~/utils/sessionMove";
import type { SessionTraceRun } from "./sessionTraceTypes";

export type SessionPageView = "trace" | "conversation";

/** Cookie the Trace tab's tree/timeline split is saved under; the session loader reads it. */
// v2: layouts saved before the session-wide timeline could leave it a few px wide.
export const SESSION_TREE_AUTOSAVE_ID = "panel-session-tree-v2";

/**
 * Which left-hand tab the session page shows. Trace is the default; links to the conversation's
 * Raw view or a channel still open the conversation.
 */
export function resolveSessionPageView({
  view,
  raw,
  channel,
}: {
  view: string | undefined;
  raw: string | undefined;
  channel: string | undefined;
}): SessionPageView {
  if (view === "trace" || view === "conversation") return view;
  if (raw === "1" || channel) return "conversation";
  return "trace";
}

// Maps, not objects: a custom reason can be any string, "toString" included.
export type RunReasonBadge = { label: string; tone: "warning" | "neutral"; tooltip?: string };

const BADGE_LABELS = new Map<string, string | undefined>([
  ["initial", undefined],
  ["continuation", undefined],
  ["upgrade", "New version"],
  ["manual", "Started manually"],
  ["skew-threshold", "Skew threshold"],
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

/** A run's title in the session's run timeline: "Initial run", or the move label. */
export function sessionRunTitle(reason: string): { text: string; capitalize: boolean } {
  // A run that replaced one below the skew protection threshold; its label stands on its own.
  if (reason === SKEW_THRESHOLD_RUN_REASON)
    return { text: "Moved: skew protection threshold", capitalize: false };
  return { text: `${reason} run`, capitalize: true };
}
