import type { PrismaClientOrTransaction } from "@trigger.dev/database";

/**
 * The waitpoint and edge state operations that `WaitpointSystem` delegates.
 *
 * Orchestration stays in `WaitpointSystem`: the run lock, snapshot transitions,
 * worker-job enqueues, event emissions and racepoints. This owns waitpoint and
 * edge state only, so a non-Postgres implementation can replace it without any
 * caller learning that it changed.
 *
 * The residency hints and `tx` are opaque pass-throughs. Opaque does not mean
 * type-free — a Prisma type appears here — it means a non-Postgres implementation
 * never reads the value.
 */
export type WaitpointCoordinator = {
  clearRunBlockState(params: ClearRunBlockStateParams): Promise<{ count: number }>;
};

export type ClearRunBlockStateParams = {
  runId: string;
  /** Edge ids to delete. Omit to clear every edge for the run. */
  edgeIds?: string[];
  /**
   * Forwarded verbatim on the full-clear leg only, and never on the bounded leg
   * or an edge write. A routing store strips it; a single store joins it.
   */
  tx?: PrismaClientOrTransaction;
};
