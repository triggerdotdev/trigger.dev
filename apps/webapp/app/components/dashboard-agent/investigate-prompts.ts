/**
 * The prompt text the dashboard's "Investigate" buttons send.
 *
 * Kept out of the routes (and out of the button component) so the wording is in
 * one place and testable — these strings are product copy, and they carry real
 * identifiers so the agent starts from the thing the user is looking at.
 * Phrasing follows the suggested-prompt registry (`suggested-prompts/registry.ts`).
 */

/**
 * Run statuses that mean "this failed", so an Investigate button belongs on the
 * run. Same set as the fresh-failure signal uses (`suggested-prompts/page-mappers.ts`).
 */
const FAILED_RUN_STATUSES = new Set([
  "COMPLETED_WITH_ERRORS",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

/** Whether a run's status is a failure the agent can investigate. */
export function isFailedRunStatus(status: string): boolean {
  return FAILED_RUN_STATUSES.has(status);
}

/** "Investigate run …" — a failed run. */
export function failedRunPrompt(runFriendlyId: string): string {
  return `Investigate run ${runFriendlyId} — why did it fail?`;
}

/** "Why is run … waiting …" — a run that hasn't started yet. */
export function waitingRunPrompt(runFriendlyId: string, queueName?: string): string {
  return queueName
    ? `Why is run ${runFriendlyId} waiting to start in the ${queueName} queue?`
    : `Why is run ${runFriendlyId} waiting to start?`;
}

/** "Investigate error …" — an error group. */
export function errorGroupPrompt(errorFriendlyId: string, taskIdentifier?: string): string {
  const subject = taskIdentifier
    ? `error ${errorFriendlyId} in ${taskIdentifier}`
    : `error ${errorFriendlyId}`;
  return `Investigate ${subject} — what's causing it and is it still happening?`;
}

/** "Investigate the … queue" — a queue in warn/crit health. */
export function queueBacklogPrompt(queueName: string): string {
  return `Investigate the ${queueName} queue — why is it backed up?`;
}

/**
 * "… is paused, so nothing will start" — a task or test page whose queue is
 * paused. The name is optional: the test page knows the queue is paused but not
 * what it's called.
 */
export function pausedQueuePrompt(queueName?: string): string {
  const subject = queueName ? `The ${queueName} queue` : "The queue this task runs on";
  return `${subject} is paused, so nothing new will start on it. What's waiting behind it?`;
}

/** "Investigate batch …" — a batch that didn't come out clean. */
export function batchFailurePrompt(batchFriendlyId: string, failedRunCount?: number): string {
  const scale =
    failedRunCount !== undefined && failedRunCount > 0
      ? `${failedRunCount} of its runs failed`
      : "some of its runs failed";
  return `Investigate batch ${batchFriendlyId} — ${scale}. Which ones, and why?`;
}
