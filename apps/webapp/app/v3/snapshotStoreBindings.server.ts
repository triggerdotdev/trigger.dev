import type { SnapshotRepairEnqueuer } from "@internal/run-store";

export type SweepPassOutcome = {
  outcome: "completed" | "partial" | "skipped_locked" | "failed" | "unbound" | "aborted";
  counts?: Record<string, number | boolean>;
};

export type SweepRunner = (opts: {
  deadline: number;
  signal: AbortSignal;
}) => Promise<SweepPassOutcome>;

/** Late-bound so the run store never has to import the engine. A third module wires both at boot. */
let repairEnqueuer: SnapshotRepairEnqueuer | undefined;
let sweepRunner: SweepRunner | undefined;

export function setSnapshotRepairEnqueuer(fn: SnapshotRepairEnqueuer): void {
  repairEnqueuer = fn;
}

export function getSnapshotRepairEnqueuer(): SnapshotRepairEnqueuer | undefined {
  return repairEnqueuer;
}

export function setSnapshotSweepRunner(fn: SweepRunner): void {
  sweepRunner = fn;
}

export function getSnapshotSweepRunner(): SweepRunner | undefined {
  return sweepRunner;
}
