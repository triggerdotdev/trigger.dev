import { type TaskRunStatus } from "@trigger.dev/database";
import { type SessionDisplayStatus } from "~/services/sessionsRepository/sessionsRepository.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

export type DeriveSessionStatusInput = {
  /** `Session.closedAt` — set once when the session is explicitly closed. */
  closedAt: Date | null;
  /** `Session.expiresAt` — retention deadline, if any. */
  expiresAt: Date | null;
  /** `Session.currentRunId` — pointer to the current run (no FK). */
  currentRunId: string | null;
  /**
   * Status of the run named by `currentRunId`. `undefined` when there is no
   * current run, or the pointer couldn't be resolved (stale / cross-env).
   */
  currentRunStatus: TaskRunStatus | undefined;
  /** `Date.now()` at the time of derivation. */
  now: number;
};

/**
 * Derives the display status of a session from its terminal markers and the
 * liveness of its current run.
 *
 * Precedence: an explicit close wins, then an elapsed retention deadline. Only
 * then do we ask whether the session is genuinely live: it's `ACTIVE` when its
 * current run exists and is non-final, otherwise `IDLE` (open but nothing
 * running). This is what stops an abandoned session whose run terminated long
 * ago from reading `ACTIVE` forever.
 */
export function deriveSessionStatus(input: DeriveSessionStatusInput): SessionDisplayStatus {
  if (input.closedAt != null) {
    return "CLOSED";
  }

  if (input.expiresAt != null && input.expiresAt.getTime() < input.now) {
    return "EXPIRED";
  }

  const hasLiveRun =
    input.currentRunId != null &&
    input.currentRunStatus !== undefined &&
    !isFinalRunStatus(input.currentRunStatus);

  return hasLiveRun ? "ACTIVE" : "IDLE";
}
