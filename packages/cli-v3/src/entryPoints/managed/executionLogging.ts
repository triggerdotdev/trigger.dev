import type { WorkloadRunAttemptStartResponseBody } from "@trigger.dev/core/v3/workers";

/**
 * Builds the debug-log properties for the "started attempt" entry.
 *
 * The raw `startRunAttempt` response body carries `envVars` — the project environment
 * variables injected into the run — plus the trigger payload and run metadata. Logging the
 * response as-is wrote all of that to the runner's stdout, and to the webapp debug-log
 * endpoint when `TRIGGER_SEND_RUN_DEBUG_LOGS` is enabled.
 *
 * `envVars` keys are user-defined, so no name-based deny-list can reliably classify them.
 * Only the names are logged, never the values — enough to confirm which variables reached the
 * run. Everything else is an explicit allow-list of identifiers, so a new field on the API
 * response can't reintroduce a leak.
 */
export function startedAttemptLogProperties(start: WorkloadRunAttemptStartResponseBody) {
  return {
    runId: start.run.id,
    runFriendlyId: start.run.friendlyId,
    runStatus: start.run.status,
    attemptNumber: start.run.attemptNumber,
    snapshotId: start.snapshot.friendlyId,
    executionStatus: start.snapshot.executionStatus,
    taskIdentifier: start.execution.task.id,
    queue: start.execution.queue.name,
    machinePreset: start.execution.machine.name,
    isTest: start.execution.run.isTest,
    envVarKeys: Object.keys(start.envVars ?? {}),
  };
}
