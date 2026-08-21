import { type TaskRunStatus } from "@trigger.dev/database";
import { isFinalRunStatus } from "~/v3/taskStatus";

export type IsSessionLiveInput = {
  /** Whether the session points at a current run at all. */
  hasCurrentRun: boolean;
  /**
   * Status of the current run. `undefined` when there is no current run, or the
   * pointer couldn't be resolved (stale / cross-env).
   */
  currentRunStatus: TaskRunStatus | undefined;
};

/**
 * A session is "live" when its current run is still executing (a non-final run
 * status). This drives whether the session's duration ticks or freezes; it does
 * NOT change the session's status, which stays the filterable
 * `ACTIVE`/`CLOSED`/`EXPIRED` set derived from `closedAt`/`expiresAt`.
 */
export function isSessionLive({ hasCurrentRun, currentRunStatus }: IsSessionLiveInput): boolean {
  return hasCurrentRun && currentRunStatus !== undefined && !isFinalRunStatus(currentRunStatus);
}
