// Same set as the fresh-failure signal in `suggested-prompts/page-mappers.ts`.
const FAILED_RUN_STATUSES = new Set([
  "COMPLETED_WITH_ERRORS",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

export function isFailedRunStatus(status: string): boolean {
  return FAILED_RUN_STATUSES.has(status);
}

// Runs actively executing (or between execution attempts), as opposed to still queued/pending
// or already finished — the queued/pending case gets its own waiting-block prompt instead.
const IN_PROGRESS_RUN_STATUSES = new Set([
  "EXECUTING",
  "DEQUEUED",
  "RETRYING_AFTER_FAILURE",
  "WAITING_TO_RESUME",
]);

export function isInProgressRunStatus(status: string): boolean {
  return IN_PROGRESS_RUN_STATUSES.has(status);
}

export function failedRunPrompt(runFriendlyId: string): string {
  return `Investigate run ${runFriendlyId} — why did it fail?`;
}

export function runningRunPrompt(runFriendlyId: string): string {
  return `Investigate run ${runFriendlyId} — what has it been doing so far, and is it healthy?`;
}

export function waitingRunPrompt(runFriendlyId: string, queueName?: string): string {
  return queueName
    ? `Why is run ${runFriendlyId} waiting to start in the ${queueName} queue?`
    : `Why is run ${runFriendlyId} waiting to start?`;
}

export function errorGroupPrompt(errorFriendlyId: string, taskIdentifier?: string): string {
  const subject = taskIdentifier
    ? `error ${errorFriendlyId} in ${taskIdentifier}`
    : `error ${errorFriendlyId}`;
  return `Investigate ${subject} — what's causing it and is it still happening?`;
}

export function queueBacklogPrompt(queueName: string): string {
  return `Investigate the ${queueName} queue — why is it backed up?`;
}

// The name is optional: the test page knows its queue is paused but not what it's called.
export function pausedQueuePrompt(queueName?: string): string {
  const subject = queueName ? `The ${queueName} queue` : "The queue this task runs on";
  return `${subject} is paused, so nothing new will start on it. What's waiting behind it?`;
}

export function batchFailurePrompt(batchFriendlyId: string, failedRunCount?: number): string {
  const scale =
    failedRunCount !== undefined && failedRunCount > 0
      ? `${failedRunCount} of its runs failed`
      : "some of its runs failed";
  return `Investigate batch ${batchFriendlyId} — ${scale}. Which ones, and why?`;
}
