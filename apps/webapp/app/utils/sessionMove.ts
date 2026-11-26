// A session moving to a newer run: why its runs start, and the cancel reason on a run that a
// newer run replaced because it was below a skew protection threshold. The cancel reason is
// written by the session run manager and read back by it (a move in flight) and by the run page,
// so the text and its parser live together, outside any `.server` module.

/** Every `SessionRun.reason` the webapp records. */
export const SESSION_RUN_REASONS = [
  "initial",
  "continuation",
  "upgrade",
  "manual",
  "skew-threshold",
] as const;
export type SessionRunReason = (typeof SESSION_RUN_REASONS)[number];

/** The reason of a run that replaced one below a skew protection threshold, at the next message. */
export const SKEW_THRESHOLD_RUN_REASON = "skew-threshold" satisfies SessionRunReason;

export type SupersededRunCancelReason = {
  movedToVersion: string;
  newRunFriendlyId: string;
  /** Set when the task's own threshold moved the session, not the environment's. */
  taskIdentifier?: string;
};

/** Names the threshold that moved the session and the run it continued in. */
export function supersededRunCancelReason(params: SupersededRunCancelReason): string {
  const threshold = params.taskIdentifier
    ? `the skew protection threshold for ${params.taskIdentifier}`
    : "the skew protection threshold";
  return `Moved to ${params.movedToVersion} by ${threshold}. Continued in ${params.newRunFriendlyId}.`;
}

// The task id is free text (newlines too, hence `s`), so it is matched greedily up to the fixed
// ending.
const REASON_PATTERN =
  /^Moved to (\S+) by the skew protection threshold(?: for (.+))?\. Continued in (run_[A-Za-z0-9_]+)\.$/s;

/** The parts of a reason written by {@link supersededRunCancelReason}; undefined for any other text. */
export function parseSupersededRunCancelReason(
  reason: string | null | undefined
): SupersededRunCancelReason | undefined {
  const match = reason ? REASON_PATTERN.exec(reason) : null;
  if (!match) return undefined;
  return {
    movedToVersion: match[1],
    newRunFriendlyId: match[3],
    ...(match[2] ? { taskIdentifier: match[2] } : {}),
  };
}
