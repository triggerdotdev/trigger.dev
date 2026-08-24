export const MAX_TASK_RUN_ATTEMPTS = 250;

/**
 * The status and description a run's default entry into the queue is written with. Shared because
 * the trigger path writes this snapshot nested in the run-create transaction and then emits its own
 * `executionSnapshotCreated`, while every re-enqueue writes it through `enqueueRun`. Three places
 * have to agree, or the persisted row and the run timeline's `[engine]` entry drift apart.
 * Re-enqueues that describe why they requeued pass their own description instead.
 */
export const QUEUED_SNAPSHOT_STATUS = "QUEUED" as const;
export const QUEUED_SNAPSHOT_DESCRIPTION = "Run was QUEUED";
