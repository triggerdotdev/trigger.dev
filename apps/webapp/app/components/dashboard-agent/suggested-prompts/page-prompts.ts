/**
 * Which chips each page kind offers, per slot. The `*Prompt` helpers below decide
 * whether a conditional chip applies at all.
 */
import type { AgentPage, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import {
  batchFailurePrompt,
  isFailedRunStatus,
  pausedQueuePrompt,
  queueBacklogPrompt,
} from "../investigate-prompts";
import { isFailedBatchStatus } from "./page-mappers";
import { def, PROMPT_SLOTS, type PageSlotPrompts } from "./prompt-chips";
import {
  DOCS_AGENTS,
  DOCS_ALERTS,
  DOCS_AUTH,
  DOCS_BATCHES,
  DOCS_BRANCHES,
  DOCS_BULK_ACTIONS,
  DOCS_CONCURRENCY,
  DOCS_DASHBOARDS,
  DOCS_DEPLOYS,
  DOCS_ENVIRONMENTS,
  DOCS_ENVVARS,
  DOCS_ERRORS,
  DOCS_GENERIC,
  DOCS_LIMITS,
  DOCS_LOGS,
  DOCS_MODELS,
  DOCS_PROMPTS,
  DOCS_QUERY,
  DOCS_REGIONS,
  DOCS_RETRIES,
  DOCS_SCHEDULES,
  DOCS_SESSIONS,
  DOCS_TASKS,
  DOCS_TRIGGERING,
  DOCS_WAITPOINTS,
  EXPLAIN_PAGE,
} from "./docs-prompts";

const RUNNING_BATCH_STATUSES = new Set(["PENDING", "PROCESSING"]);

/** A canceled deploy is deliberate, so it's excluded. */
const FAILED_DEPLOYMENT_STATUSES = new Set(["FAILED", "TIMED_OUT"]);

function isFailedDeploymentStatus(status: string | undefined): boolean {
  return status !== undefined && FAILED_DEPLOYMENT_STATUSES.has(status);
}

export function pageSlotPrompts(page: AgentPage): PageSlotPrompts {
  switch (page.kind) {
    case "runs":
      return {
        explain: def(
          "runs-failing-most",
          "Show me failed runs from today",
          "Which tasks are failing most in the last 24 hours?"
        ),
        docs: def(
          "docs-run-filters",
          "How do I filter runs?",
          "How do I filter and search runs in Trigger.dev?"
        ),
      };

    case "run":
      return {
        investigate: def(
          "run-investigate",
          "What happened in this run?",
          `Investigate ${page.runId} — walk me through what happened.`
        ),
        explain: def(
          "run-task-health",
          "Is this task healthy?",
          `How has ${page.taskId} been performing recently?`
        ),
        docs: DOCS_RETRIES,
      };

    case "errors":
      return {
        explain: def(
          "errors-worst",
          "Which errors matter most?",
          "Which errors are hitting the most runs right now, and which are new?"
        ),
        docs: DOCS_ERRORS,
      };

    case "error":
      return {
        investigate: def(
          "error-cause",
          "Why does this keep happening?",
          "Investigate this error — why does it keep coming back, and which runs are affected?"
        ),
        watch: def(
          "error-watch-recurrence",
          "Tell me if it comes back",
          "Watch this error and tell me if it happens again."
        ),
        explain: def(
          "error-similar",
          "Find similar failures",
          "Find other failures that look like this one."
        ),
        docs: DOCS_ERRORS,
      };

    case "queues":
      return {
        explain: def(
          "queues-busiest",
          "Which queues are busiest?",
          "Which queues have the deepest backlogs right now, and are they clearing?"
        ),
        docs: DOCS_CONCURRENCY,
      };

    case "queue":
      return {
        // A paused queue is backed up because someone paused it, and nothing it could be
        // watched for will happen until they resume it — so neither chip is offered.
        investigate:
          !page.paused && (page.health === "warn" || page.health === "crit")
            ? def(
                "queue-backlog-cause",
                "Why is this queue backed up?",
                queueBacklogPrompt(page.name)
              )
            : undefined,
        watch: page.paused
          ? undefined
          : def(
              "queue-watch-drain",
              "Tell me when the backlog drains",
              `Watch the ${page.name} queue and tell me when the backlog drains.`
            ),
        status: def(
          "queue-backlog",
          "How big is the backlog?",
          `How big is the backlog on the ${page.name} queue, and is it clearing?`
        ),
        explain: def(
          "queue-state",
          "How is this queue doing?",
          `Explain the current state of the ${page.name} queue.`
        ),
        docs: DOCS_CONCURRENCY,
      };

    case "deployments":
      return {
        explain: def(
          "deployments-latest",
          "How is the latest deploy doing?",
          "How is the latest deployment doing, and did anything start failing after it?"
        ),
        docs: DOCS_DEPLOYS,
      };

    case "deployment":
      return {
        investigate: isFailedDeploymentStatus(page.status)
          ? def(
              "deployment-failure",
              "Why did this deploy fail?",
              `Investigate deployment ${page.version} — why did it fail?`
            )
          : undefined,
        explain: def(
          "deployment-diff",
          "What changed in this deploy?",
          `What changed in deployment ${page.version}?`
        ),
        docs: DOCS_DEPLOYS,
      };

    case "tasks":
      return {
        explain: def(
          "tasks-busiest",
          "Which tasks run most often?",
          "Which of my tasks runs most often, and which one takes the longest?"
        ),
        docs: DOCS_TASKS,
      };

    case "task":
      return {
        investigate: taskBlockedPrompt(page),
        explain: def(
          "task-health",
          "How is this task doing?",
          `How has ${page.taskId} been performing — failure rate, duration, and its recent runs?`
        ),
        docs: page.triggerSource === "SCHEDULED" ? DOCS_SCHEDULES : DOCS_TASKS,
      };

    case "schedule":
      return {
        investigate:
          page.active === false
            ? def(
                "schedule-disabled",
                "Why hasn't this fired?",
                `Schedule ${page.scheduleId} is disabled, so ${page.taskId} isn't running on it. When did it last fire, and how did those runs go?`
              )
            : undefined,
        explain: def(
          "schedule-adherence",
          "Is this running on time?",
          `Is ${page.taskId} running on schedule — have its recent runs fired when expected and finished cleanly?`
        ),
        docs: DOCS_SCHEDULES,
      };

    case "batches":
      return {
        investigate: page.latestFailedBatchId
          ? def(
              "batches-latest-failed",
              "Why did my last batch fail?",
              batchFailurePrompt(page.latestFailedBatchId)
            )
          : undefined,
        explain: def(
          "batches-recent",
          "How are my batches doing?",
          "How have my recent batches done, and which of them had runs fail?"
        ),
        docs: DOCS_BATCHES,
      };

    case "batch":
      return {
        investigate:
          isFailedBatchStatus(page.status) || (page.failedRunCount ?? 0) > 0
            ? def(
                "batch-failures",
                "Why did these runs fail?",
                batchFailurePrompt(page.batchId, page.failedRunCount)
              )
            : undefined,
        status: RUNNING_BATCH_STATUSES.has(page.status ?? "")
          ? def(
              "batch-progress",
              "Is this batch still going?",
              `Is batch ${page.batchId} still processing, and how many of its runs are left?`
            )
          : undefined,
        explain: def(
          "batch-outcome",
          "How did this batch do?",
          `How did batch ${page.batchId} do — how many of its runs succeeded, and how many failed?`
        ),
        docs: DOCS_BATCHES,
      };

    case "test":
      return {
        investigate: page.queuePaused
          ? def("test-queue-paused", "Why won't my test run?", pausedQueuePrompt())
          : undefined,
        explain: page.taskId
          ? def(
              "test-payload",
              "What payload does this take?",
              `What payload does ${page.taskId} expect, and what's a realistic example I can send?`
            )
          : def(
              "test-what-to-trigger",
              "What can I trigger here?",
              "Which tasks can I trigger in this environment, and what payload does each one expect?"
            ),
        docs: DOCS_TRIGGERING,
      };

    case "alerts":
      return {
        status:
          (page.disabledChannelCount ?? 0) > 0
            ? def(
                "alerts-disabled-channel",
                "Why aren't I getting alerts?",
                "One of my alert channels is switched off. What have I been missing notifications about?"
              )
            : undefined,
        explain: def(
          "alerts-what-to-watch",
          "What should I be alerting on?",
          "Which failures in this environment would be worth an alert right now?"
        ),
        docs: DOCS_ALERTS,
      };

    case "apikeys":
      return {
        explain: def(
          "apikeys-which",
          "Which key do I use where?",
          "Which key should I use for this environment, and what are my other environments?"
        ),
        docs: DOCS_AUTH,
      };

    case "envvars":
      return {
        explain: def(
          "envvars-needed",
          "What do my tasks read?",
          "Which environment variables do my tasks read, and is anything they need missing here?"
        ),
        docs: DOCS_ENVVARS,
      };

    case "concurrency":
      return {
        explain: def(
          "concurrency-headroom",
          "Do I have enough concurrency?",
          "How much concurrency am I actually using, and is anything queueing behind the limit?"
        ),
        docs: DOCS_CONCURRENCY,
      };

    case "regions":
      return {
        explain: def(
          "regions-where",
          "Where do my runs execute?",
          "Which regions are my runs executing in, and is any of them slower than the others?"
        ),
        docs: DOCS_REGIONS,
      };

    case "settings":
      return {
        explain: def(
          "settings-where-am-i",
          "Which project am I in?",
          "Which project and environment am I looking at, and what are their ids?"
        ),
        docs: DOCS_ENVIRONMENTS,
      };

    case "waitpoints":
      return {
        investigate: waitpointStuckPrompt(page),
        explain: def(
          "waitpoints-waiting-runs",
          "Which runs are waiting?",
          "Which of my runs are waiting to resume, and how long have they been waiting?"
        ),
        docs: DOCS_WAITPOINTS,
      };

    case "bulkactions":
      return {
        investigate:
          page.bulkActionId && ((page.failedRunCount ?? 0) > 0 || page.status === "ABORTED")
            ? def(
                "bulkaction-failures",
                "Why did these runs fail?",
                `Bulk action ${page.bulkActionId} didn't finish cleanly. Which of its runs failed, and why?`
              )
            : undefined,
        status: bulkActionProgressPrompt(page),
        explain: def(
          "bulkactions-outcome",
          "How did my last one go?",
          page.bulkActionId
            ? `How did bulk action ${page.bulkActionId} go — how many runs did it touch, and how many failed?`
            : "How did my most recent bulk action go — how many runs did it touch, and how many failed?"
        ),
        docs: DOCS_BULK_ACTIONS,
      };

    case "branches":
      return {
        status: page.atLimit
          ? def(
              "branches-at-limit",
              "Why can't I add a branch?",
              "I'm at my preview branch limit. What's using them up, and what are my options?"
            )
          : undefined,
        explain: def(
          "branches-activity",
          "Which branches are busy?",
          "Which of my preview branches have run anything recently, and are any of them failing?"
        ),
        docs: DOCS_BRANCHES,
      };

    case "logs":
      return {
        explain: def(
          "logs-errors",
          "What's in my error logs?",
          "What have my tasks logged as errors in the last hour?"
        ),
        docs: DOCS_LOGS,
      };

    case "limits":
      return {
        status:
          page.exhausted && page.exhausted.length > 0
            ? def(
                "limits-hit",
                "Which limit am I hitting?",
                `I'm at my ${page.exhausted[0]} limit. What's using it up, and what happens now?`
              )
            : undefined,
        explain: def(
          "limits-headroom",
          "Am I close to any limits?",
          "Which of my limits am I closest to in this environment?"
        ),
        docs: DOCS_LIMITS,
      };

    case "query":
      return {
        explain: def(
          "query-what-can-i-ask",
          "What can I query?",
          "What tables and columns can I query here? Give me one query worth running."
        ),
        docs: DOCS_QUERY,
      };

    case "dashboards":
      return {
        explain: page.title
          ? def(
              "dashboard-read",
              "What stands out here?",
              `Read the ${page.title} dashboard for this environment and tell me what stands out.`
            )
          : def(
              "dashboards-chart",
              "Chart something for me",
              "Chart my failed runs per hour over the last day."
            ),
        docs: DOCS_DASHBOARDS,
      };

    case "agents":
      return {
        explain: def(
          "agents-health",
          "How is this agent doing?",
          page.agentId
            ? `How has the ${page.agentId} agent been running — failures, duration, and token spend?`
            : "How have my agents been running — failures, duration, and token spend?"
        ),
        docs: DOCS_AGENTS,
      };

    case "playground":
      return {
        explain: def(
          "playground-what",
          "What can I try here?",
          page.agentId
            ? `What does the ${page.agentId} agent do, and what should I send it here?`
            : "What does the playground let me do, and how do I use it with my agents?"
        ),
        docs: DOCS_AGENTS,
      };

    case "prompts":
      return {
        status: promptOverridePrompt(page),
        explain: def(
          "prompts-spend",
          "What are my prompts costing?",
          page.slug
            ? `What is the ${page.slug} prompt costing me in tokens and spend?`
            : "Which of my prompts costs the most in tokens and spend?"
        ),
        docs: DOCS_PROMPTS,
      };

    case "models":
      return {
        explain: def(
          "models-spend",
          "What am I spending on models?",
          page.modelId
            ? `What am I spending on ${page.modelId}, and which of my tasks use it most?`
            : "Which models am I spending the most on, and how has that trended?"
        ),
        docs: DOCS_MODELS,
      };

    case "sessions":
      return {
        investigate:
          page.sessionId && page.runStatus && isFailedRunStatus(page.runStatus)
            ? def(
                "session-run-failed",
                "Why did this session fail?",
                `The run behind session ${page.sessionId}${
                  page.runId ? ` (${page.runId})` : ""
                } failed. Walk me through what happened.`
              )
            : undefined,
        status:
          !page.sessionId && (page.expiredCount ?? 0) > 0
            ? def(
                "sessions-expired",
                "Why did sessions expire?",
                "Some of my sessions expired instead of being closed. What was still running in them?"
              )
            : undefined,
        explain: def(
          "sessions-activity",
          "How are my sessions doing?",
          page.sessionId
            ? `What happened in session ${page.sessionId} — which runs did it trigger, and how did they end?`
            : "How many sessions ran recently, and how did their runs end?"
        ),
        docs: DOCS_SESSIONS,
      };

    case "other":
      return { explain: EXPLAIN_PAGE, docs: DOCS_GENERIC };
  }
}

/** Order matters, worst first: never fired, then stopped firing, then a paused queue. */
function taskBlockedPrompt(
  page: Extract<AgentPage, { kind: "task" }>
): SuggestedPrompt | undefined {
  const { schedules, queue, queuePaused, taskId } = page;

  if (schedules && schedules.total === 0) {
    return def(
      "task-no-schedules",
      "Why has this never run?",
      `${taskId} is a scheduled task with no schedule attached, so it never fires. What do I need to add?`
    );
  }

  if (schedules && schedules.total > 0 && schedules.active === 0) {
    return def(
      "task-schedules-disabled",
      "Why has this stopped running?",
      `Every schedule on ${taskId} is disabled, so it isn't firing any more. When did it last run?`
    );
  }

  if (queuePaused) {
    return def("task-queue-paused", "Why isn't this task running?", pausedQueuePrompt(queue));
  }

  return undefined;
}

function waitpointStuckPrompt(
  page: Extract<AgentPage, { kind: "waitpoints" }>
): SuggestedPrompt | undefined {
  if (page.tokenId) {
    return page.status === "TIMED_OUT"
      ? def(
          "waitpoint-timed-out",
          "Why did this time out?",
          `Token ${page.tokenId} timed out instead of being completed. Which run was waiting on it?`
        )
      : undefined;
  }

  return (page.timedOutCount ?? 0) > 0 || (page.overdueCount ?? 0) > 0
    ? def(
        "waitpoints-stuck",
        "Which tokens are stuck?",
        "Some of my wait tokens timed out or are still waiting past their timeout. Which runs are blocked on them?"
      )
    : undefined;
}

function bulkActionProgressPrompt(
  page: Extract<AgentPage, { kind: "bulkactions" }>
): SuggestedPrompt | undefined {
  if (page.bulkActionId) {
    return page.status === "PENDING"
      ? def(
          "bulkaction-progress",
          "Is this still running?",
          `Is bulk action ${page.bulkActionId} still working through its runs, and how far has it got?`
        )
      : undefined;
  }

  return (page.pendingCount ?? 0) > 0
    ? def(
        "bulkactions-pending",
        "Is anything still running?",
        "Is a bulk action still working through its runs right now?"
      )
    : undefined;
}

function promptOverridePrompt(
  page: Extract<AgentPage, { kind: "prompts" }>
): SuggestedPrompt | undefined {
  if (page.slug) {
    return page.overridden
      ? def(
          "prompt-override",
          "Why is an override live?",
          `The ${page.slug} prompt has a version override pinned, so runs aren't using its current version. What's the difference?`
        )
      : undefined;
  }

  return (page.overriddenCount ?? 0) > 0
    ? def(
        "prompts-overrides",
        "Which prompts are overridden?",
        "Some of my prompts have a version override pinned, so they aren't running their current version. Which ones?"
      )
    : undefined;
}

export function pageDefaultPrompts(page: AgentPage): SuggestedPrompt[] {
  const slots = pageSlotPrompts(page);
  return PROMPT_SLOTS.map((slot) => slots[slot]).filter(
    (prompt): prompt is SuggestedPrompt => prompt !== undefined
  );
}
