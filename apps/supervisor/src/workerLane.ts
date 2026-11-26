import { computeOnlyReason } from "@trigger.dev/core/v3";
import type { RunnerRuntime } from "./workloadManager/runCrd.js";

export type WorkloadManagerBackend = "kubernetes" | "run-crd" | "docker";

/** The isolation lane every run started by a supervisor on this backend executes in. */
export function workerLaneFor(
  backend: WorkloadManagerBackend,
  runnerRuntime: RunnerRuntime
): RunnerRuntime {
  switch (backend) {
    case "run-crd":
      return runnerRuntime;
    case "kubernetes":
    case "docker":
      return "container";
  }
}

/**
 * Whether a dequeued run may be handed to a warm runner. A sandbox never reuses a process or VM
 * another run has used, and a compute-only run always cold starts: the warm-start key has no
 * runtime, so a container runner of the same version and machine could otherwise take it.
 */
export function mayWarmStart(annotations: unknown): boolean {
  return computeOnlyReason(annotations) === undefined;
}
