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
