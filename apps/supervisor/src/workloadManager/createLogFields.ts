import type { WorkloadManagerCreateOptions } from "./types.js";

export function createLogFields(opts: WorkloadManagerCreateOptions) {
  return {
    runId: opts.runFriendlyId,
    attemptNumber: opts.nextAttemptNumber,
    snapshotId: opts.snapshotFriendlyId,
    deploymentId: opts.deploymentFriendlyId,
    deploymentVersion: opts.deploymentVersion,
    image: opts.image,
    machine: opts.machine.name,
    runtime: opts.runtime,
    envId: opts.envId,
    orgId: opts.orgId,
    projectId: opts.projectId,
  };
}
