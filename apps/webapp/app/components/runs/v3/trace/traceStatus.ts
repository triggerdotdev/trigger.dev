export type TraceStatus =
  | { kind: "failed"; reason: string }
  | { kind: "loading"; reason: string }
  | { kind: "partial"; reason: string }
  | { kind: "live" }
  | { kind: "liveOff"; reason: string }
  | { kind: "allLoaded" }
  | { kind: "none" };

const FILTERS_INCOMPLETE = "Search and filters may be incomplete.";

export type TraceStatusInput = {
  runFinished: boolean;
  rootSpanStatus: "executing" | "completed" | "failed";
  isComplete: boolean;
  isTruncated: boolean;
  /** The trace is too large to anchor its root, so almost nothing can be shown. */
  missingAnchor: boolean;
  loadFailed: boolean;
  isLiveReloading: boolean;
  liveTailEnabled: boolean;
  maximumLiveReloadingSetting: number;
};

/** One status for the whole trace view. Earlier checks win. */
export function getTraceStatus(input: TraceStatusInput): TraceStatus {
  // The run row and the tree can disagree for a moment; either one saying "done" wins.
  const finished = input.runFinished || input.rootSpanStatus !== "executing";
  const liveStopped = !finished && !input.isLiveReloading;

  if (input.loadFailed && !input.isTruncated) {
    const paused = liveStopped ? " Live updates are paused until it loads." : "";
    return {
      kind: "failed",
      reason: `Some of this trace couldn't be loaded, so it's shown partially.${paused} ${FILTERS_INCOMPLETE}`,
    };
  }
  if (!input.isComplete) {
    return {
      kind: "loading",
      reason: "Search and filters may be incomplete until all spans load.",
    };
  }
  if (input.isTruncated) {
    const off = liveStopped ? " Live updates are off." : "";
    const reason = input.missingAnchor
      ? `This trace is too large to display.${off}`
      : `This trace has more spans than can be shown, so it's partially displayed.${off}`;
    return { kind: "partial", reason: `${reason} ${FILTERS_INCOMPLETE}` };
  }
  if (finished) return { kind: "allLoaded" };
  if (input.isLiveReloading) return { kind: "live" };

  if (!input.liveTailEnabled) {
    return {
      kind: "liveOff",
      reason: `Live updates are off because this trace has more than ${input.maximumLiveReloadingSetting} spans and logs.`,
    };
  }

  // Defensive: unreachable with the current live reload rules.
  return { kind: "none" };
}
