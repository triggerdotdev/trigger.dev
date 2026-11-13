import type { Redis } from "@internal/redis";
import type { Logger } from "@trigger.dev/core/logger";
import type { TaskRunInternalError } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";

/**
 * What a run fails with when its task returned while the engine was moving the run back to
 * EXECUTING from a wait, so the completion named the snapshot before that move.
 */
export const RETURNED_WHILE_RESUMING_ERROR = {
  type: "INTERNAL_ERROR",
  code: "TASK_RUN_CRASHED",
  message:
    "The task returned while the run was resuming from a wait, so its result was not recorded. A task must await every wait it starts before it returns, for example a wait raced against a timeout or an abort signal.",
} satisfies TaskRunInternalError;

/**
 * How a completion that names an older snapshot relates to the latest one. The continue rules are
 * settled at once when the engine's `staleCompletionMode` is "enforce"; `finished` and `other` are
 * refused. `waitpoint_continue_unverified` is what "count" mode reports in place of
 * `waitpoint_continue`, because it does not read the named snapshot to compare runners.
 */
export type StaleCompletionRule =
  | "finished"
  | "waitpoint_continue"
  | "waitpoint_continue_unverified"
  | "restore_continue"
  | "other";

const StaleCompletionNote = z.object({
  postedSnapshotId: z.string(),
  latestSnapshotId: z.string(),
  attemptNumber: z.number().nullable(),
  ok: z.boolean(),
  at: z.number(),
});

export type StaleCompletionNote = z.infer<typeof StaleCompletionNote>;

/** How late the stall job may run after its deadline and still be matched to a note. */
const STALL_JOB_DELAY_ALLOWANCE_MS = 5_000;

/**
 * Whether a stalled snapshot is explained by a refused completion: the task returned, its
 * completion was refused while this snapshot was the latest, and nothing has heartbeated since.
 * Heartbeat times are not stored, but the stall job only runs one full timeout after the last
 * heartbeat or the snapshot's creation, so no heartbeat can be later than `now - timeoutMs`. A
 * copy of the process that carried on after the refusal heartbeats, which moves that bound past
 * the note.
 */
export function refusalExplainsStall({
  note,
  snapshot,
  timeoutMs,
  now = Date.now(),
}: {
  note: StaleCompletionNote;
  snapshot: { id: string; attemptNumber: number | null; createdAt: Date };
  timeoutMs: number;
  now?: number;
}): boolean {
  // The error says the task returned, so a refused failure keeps the ordinary stall error.
  if (!note.ok || note.attemptNumber !== snapshot.attemptNumber) {
    return false;
  }

  // A snapshot made after the refusal belongs to whatever carried on, for example a restored copy
  // of the process. If that stalls before its first heartbeat, the refusal is not the reason.
  if (note.latestSnapshotId !== snapshot.id) {
    return false;
  }

  const silentSince = Math.max(note.at, snapshot.createdAt.getTime());
  return now - timeoutMs <= silentSince + STALL_JOB_DELAY_ALLOWANCE_MS;
}

/**
 * Remembers the last completion refused for a run that had not finished, when it came from the
 * runner that owns the run's latest snapshot. The stall handler runs later and usually in another
 * process, so the note lives in Redis, one key per run.
 */
export class StaleCompletionNotes {
  constructor(
    private readonly options: {
      redis: Redis;
      /** Long enough to outlive the wait for the stall that follows a refusal. */
      ttlMs: number;
      logger: Logger;
    }
  ) {}

  async write(runId: string, note: StaleCompletionNote): Promise<void> {
    try {
      await this.options.redis.set(
        this.#key(runId),
        JSON.stringify(note),
        "PX",
        this.options.ttlMs
      );
    } catch (error) {
      // Without the note a later stall reports the ordinary stall error.
      this.options.logger.warn("Failed to note a refused completion", { runId, error });
    }
  }

  async read(runId: string): Promise<StaleCompletionNote | undefined> {
    try {
      const raw = await this.options.redis.get(this.#key(runId));
      if (!raw) {
        return undefined;
      }

      const note = StaleCompletionNote.safeParse(JSON.parse(raw));
      return note.success ? note.data : undefined;
    } catch (error) {
      this.options.logger.warn("Failed to read a refused completion note", { runId, error });
      return undefined;
    }
  }

  #key(runId: string) {
    return `stale-completion:${runId}`;
  }
}
