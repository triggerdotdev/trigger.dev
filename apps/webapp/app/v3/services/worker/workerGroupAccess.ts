import { WorkerInstanceGroupType } from "@trigger.dev/database";

/**
 * Whether a worker group's attempt-start stamp (cell, lane) describes platform
 * infrastructure. UNMANAGED groups are customer-run, so their stamps are dropped.
 */
export function acceptsWorkerStamp(workerGroupType: WorkerInstanceGroupType): boolean {
  return workerGroupType === WorkerInstanceGroupType.MANAGED;
}

/**
 * Whether a worker group may be used by the calling project.
 *
 * MANAGED groups are shared across projects. UNMANAGED groups are per-project
 * (masterQueue is `${projectId}-${name}`), so a project may only use an
 * UNMANAGED group whose `projectId` matches it. Dependency-free so it can be
 * unit-tested directly.
 */
export function isWorkerGroupAllowedForProject(
  workerGroup: { type: WorkerInstanceGroupType; projectId: string | null },
  projectId: string
): boolean {
  if (workerGroup.type === WorkerInstanceGroupType.UNMANAGED) {
    return workerGroup.projectId === projectId;
  }
  return true;
}
