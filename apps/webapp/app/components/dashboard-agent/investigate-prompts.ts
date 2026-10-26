import type { AlertParams } from "@internal/alert-contracts";

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
  return `Investigate run ${runFriendlyId} - why did it fail?`;
}

export function runningRunPrompt(runFriendlyId: string): string {
  return `Investigate run ${runFriendlyId} - what has it been doing so far, and is it healthy?`;
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
  return `Investigate ${subject} - what's causing it and is it still happening?`;
}

function alertScopeLabel(scope: AlertParams["scope"]): string {
  switch (scope.type) {
    case "queue":
      return `queue ${scope.queue}`;
    case "queuePattern":
      return `queues matching ${scope.pattern}`;
    case "task":
      return `task ${scope.taskIdentifier}`;
    case "all":
      return "the whole environment";
    case "errorGroup":
      return `${scope.taskIdentifier} · ${scope.fingerprint.slice(0, 8)}`;
  }
}

export type AlertInvestigateContext = {
  alertId: string;
  capabilityKey: string;
  environmentId: string;
  scope: AlertParams["scope"] | undefined;
  name: string;
  capabilityTitle: string;
  conditionSummary: string;
  windowSec?: number;
  /** Frozen at the alert's most recent "raised" event -- not re-queried live. */
  latestRaisedEventFacts?: Record<string, unknown>;
};

/**
 * Structured handoff to the agent (DEC-089/spec §2.7): the alert identity, its scope
 * and time window, and the facts frozen at the last raise -- plus the interpretation
 * rule that this is an issue investigation, not a single run.
 */
export function alertInvestigatePrompt(alert: AlertInvestigateContext): string {
  const window = alert.windowSec ? ` over the last ${alert.windowSec}s` : "";
  const facts = alert.latestRaisedEventFacts
    ? ` Facts at the last raise: ${JSON.stringify(alert.latestRaisedEventFacts)}.`
    : "";

  const scope = alert.scope ? alertScopeLabel(alert.scope) : undefined;

  return (
    `Investigate the "${alert.name}" alert - alertId=${alert.alertId}, ` +
    `capabilityKey=${alert.capabilityKey}, environmentId=${alert.environmentId}, ` +
    `scope=${scope ?? "unknown"}${window}. Condition: ${alert.conditionSummary}.` +
    `${facts} Treat this as an investigation into ${scope ?? "the alert's scope"} as a whole - ` +
    `what changed and why - never a single run.`
  );
}

export function queueBacklogPrompt(queueName: string): string {
  return `Investigate the ${queueName} queue - why is it backed up?`;
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
  return `Investigate batch ${batchFriendlyId} - ${scale}. Which ones, and why?`;
}

/** DEC-067(a): the alerts list "New alert" button opens the chat with this instead of a form. */
export function createAlertPrompt(environmentName: string): string {
  return (
    `Help me set up a new alert for the ${environmentName} environment. ` +
    `Ask me what I want to be alerted about, then use your monitoring/alert tools to guide me ` +
    `through creating it - don't just describe the steps.`
  );
}
