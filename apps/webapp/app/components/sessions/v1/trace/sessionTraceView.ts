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

const REASON_LABELS: Record<string, string> = {
  initial: "First run",
  continuation: "Continued after the previous run ended",
  upgrade: "Moved to a new version",
  manual: "Started manually",
};

/** Why the run started, in words. Custom reasons from end-and-continue show as they were sent. */
export function runReasonLabel(run: Pick<SessionTraceRun, "reason" | "afterCrash">) {
  if (run.afterCrash) return "Restarted after the previous run crashed";
  return REASON_LABELS[run.reason] ?? run.reason;
}
