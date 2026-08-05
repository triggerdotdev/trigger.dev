/**
 * The chips the panel can offer. `resolver.ts` orders the slots and applies the
 * cap. Pure: no React, no server imports, no clock beyond the `now` passed in.
 */
import type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
  AgentPageSignalKind,
  SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";
import {
  batchFailurePrompt,
  isFailedRunStatus,
  pausedQueuePrompt,
  queueBacklogPrompt,
} from "../investigate-prompts";
import { isFailedBatchStatus } from "./page-mappers";

/**
 * Chip ids must stay stable and carry no run/queue identity: dismissals are stored
 * by id, so `fresh-failure:run_abc` would scope the dismissal to a single run.
 */
const ID_PREFIX = "sp";

function make(
  id: string,
  label: string,
  prompt: string,
  source: SuggestedPrompt["source"]
): SuggestedPrompt {
  return { id: `${ID_PREFIX}:${id}`, label, prompt, source };
}

const def = (id: string, label: string, prompt: string) => make(id, label, prompt, "default");
const ctx = (id: string, label: string, prompt: string) => make(id, label, prompt, "contextual");

/** The slots after the promoted one, in display order. */
export const PROMPT_SLOTS = ["investigate", "watch", "status", "explain", "docs"] as const;

export type PromptSlot = (typeof PROMPT_SLOTS)[number];

export type PageSlotPrompts = {
  investigate?: SuggestedPrompt;
  watch?: SuggestedPrompt;
  status?: SuggestedPrompt;
  explain: SuggestedPrompt;
  docs: SuggestedPrompt;
};

const EXPLAIN_PAGE = def(
  "explain-page",
  "Explain this page",
  "Explain what this page shows and what I can do here."
);
const DOCS_GENERIC = def(
  "docs-generic",
  "How do I use Trigger.dev?",
  "How do I get started with Trigger.dev? Point me at the docs."
);
const DOCS_RETRIES = def(
  "docs-retries",
  "How do retries work?",
  "How do retries work in Trigger.dev?"
);
const DOCS_ERRORS = def(
  "docs-errors",
  "How do I handle errors?",
  "How do I catch and handle errors in Trigger.dev tasks?"
);
const DOCS_CONCURRENCY = def(
  "docs-concurrency",
  "How does concurrency work?",
  "How do queues and concurrency limits work in Trigger.dev?"
);
const DOCS_DEPLOYS = def(
  "docs-deploys",
  "How do deploys work?",
  "How do deployments and versions work in Trigger.dev?"
);
const DOCS_TASKS = def(
  "docs-tasks",
  "How do I write a task?",
  "How do I write and structure a task in Trigger.dev?"
);
const DOCS_SCHEDULES = def(
  "docs-schedules",
  "How do schedules work?",
  "How do cron schedules work in Trigger.dev?"
);
const DOCS_BATCHES = def(
  "docs-batches",
  "How do I trigger a batch?",
  "How do I trigger a batch of runs, and how do I read the results?"
);
const DOCS_TRIGGERING = def(
  "docs-triggering",
  "How do I trigger a task?",
  "How do I trigger a task, and what options can I pass with the payload?"
);
const DOCS_ALERTS = def(
  "docs-alerts",
  "How do I set up alerts?",
  "How do alerts work, and which failures can I be notified about?"
);
const DOCS_AUTH = def(
  "docs-auth",
  "How do I authenticate?",
  "How do I authenticate the SDK with an API key?"
);
const DOCS_ENVVARS = def(
  "docs-envvars",
  "How do I set env vars?",
  "How do environment variables work, and how do I read one inside a task?"
);
const DOCS_REGIONS = def(
  "docs-regions",
  "How do I pick a region?",
  "How do I choose which region a task runs in?"
);
const DOCS_ENVIRONMENTS = def(
  "docs-environments",
  "How do environments work?",
  "How do projects and environments work in Trigger.dev?"
);
const DOCS_WAITPOINTS = def(
  "docs-waitpoints",
  "How do wait tokens work?",
  "How do wait tokens work, and how do I complete one?"
);
const DOCS_BULK_ACTIONS = def(
  "docs-bulk-actions",
  "How do I replay runs in bulk?",
  "How do I cancel or replay a lot of runs at once?"
);
const DOCS_BRANCHES = def(
  "docs-branches",
  "How do preview branches work?",
  "How do preview branches work in Trigger.dev?"
);
const DOCS_LOGS = def(
  "docs-logs",
  "How do I log from a task?",
  "How do I write logs from a task, and how long are they kept?"
);
const DOCS_LIMITS = def(
  "docs-limits",
  "What are the limits?",
  "What limits apply to my environment, and which ones can I raise?"
);
const DOCS_QUERY = def(
  "docs-query",
  "How do I write a query?",
  "How do I write a query over my runs and metrics?"
);
const DOCS_DASHBOARDS = def(
  "docs-dashboards",
  "How do dashboards work?",
  "How do I build a metrics dashboard out of my own queries?"
);
const DOCS_AGENTS = def(
  "docs-agents",
  "How do I build an agent?",
  "How do I build an agent with Trigger.dev?"
);
const DOCS_PROMPTS = def(
  "docs-prompts",
  "How do managed prompts work?",
  "How do managed prompts and prompt versions work?"
);
const DOCS_MODELS = def(
  "docs-models",
  "How do I configure a model?",
  "How do I choose and configure an LLM model in a task?"
);
const DOCS_SESSIONS = def(
  "docs-sessions",
  "How do sessions work?",
  "How do agent sessions work, and when do they expire?"
);

const RUNNING_BATCH_STATUSES = new Set(["PENDING", "PROCESSING"]);

/** A canceled deploy is deliberate, so it's excluded. */
const FAILED_DEPLOYMENT_STATUSES = new Set(["FAILED", "TIMED_OUT"]);

export function isFailedDeploymentStatus(status: string | undefined): boolean {
  return status !== undefined && FAILED_DEPLOYMENT_STATUSES.has(status);
}

export const GENERIC_PROMPTS: SuggestedPrompt[] = [EXPLAIN_PAGE, DOCS_GENERIC];

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
        investigate:
          page.health === "warn" || page.health === "crit"
            ? def(
                "queue-backlog-cause",
                "Why is this queue backed up?",
                queueBacklogPrompt(page.name)
              )
            : undefined,
        watch: def(
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

export const SIGNAL_SLOT: Record<AgentPageSignalKind, PromptSlot> = {
  fresh_failure: "investigate",
  slow_run: "investigate",
  waiting_run: "watch",
  concurrency_saturation: "watch",
};

/** Signal precedence within a slot. Mirrors `demoSignalsByPriority` in the fixtures. */
export const SIGNAL_PRIORITY: AgentPageSignalKind[] = [
  "fresh_failure",
  "waiting_run",
  "slow_run",
  "concurrency_saturation",
];

/** "3m", "2h", "4d". */
export function formatAgo(ms: number): string {
  if (ms < 60_000) return "moments";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** "2.4x" under 10x, "31x" above. */
export function formatMultiplier(factor: number): string {
  return factor < 10 ? `${factor.toFixed(1)}x` : `${Math.round(factor)}x`;
}

/** Undefined when the signal lacks the data to say anything, e.g. a `slow_run` with no baseline. */
export function promptForSignal(signal: AgentPageSignal, now: number): SuggestedPrompt | undefined {
  switch (signal.kind) {
    case "fresh_failure": {
      const failedAt = Date.parse(signal.failedAt);
      const ago = Number.isNaN(failedAt) ? undefined : formatAgo(Math.max(0, now - failedAt));
      return ctx(
        "fresh-failure",
        "Why did this run fail?",
        ago
          ? `Investigate ${signal.runId} — it failed ${ago} ago. What went wrong?`
          : `Investigate why ${signal.runId} failed.`
      );
    }

    case "waiting_run":
      return ctx(
        "waiting-run",
        "Tell me when this run starts",
        signal.queue
          ? `Watch ${signal.runId} and tell me when it leaves the ${signal.queue} queue.`
          : `Watch ${signal.runId} and tell me when it starts running.`
      );

    case "slow_run": {
      if (signal.baselineP95Ms <= 0) return undefined;
      const factor = formatMultiplier(signal.durationMs / signal.baselineP95Ms);
      return ctx(
        "slow-run",
        `~${factor} slower than usual`,
        `${signal.runId} is running ~${factor} slower than this task's usual p95. Investigate why.`
      );
    }

    case "concurrency_saturation":
      return ctx(
        "concurrency-saturation",
        "Tell me when the backlog drains",
        "Concurrency is saturated right now. Watch it and tell me when the backlog drains."
      );
  }
}

/** In precedence order. */
export function contextualPrompts(context: AgentPageContext, now: number): SuggestedPrompt[] {
  const prompts: SuggestedPrompt[] = [];
  for (const kind of SIGNAL_PRIORITY) {
    for (const signal of context.signals) {
      if (signal.kind !== kind) continue;
      const prompt = promptForSignal(signal, now);
      if (prompt) prompts.push(prompt);
    }
  }
  return prompts;
}

/** Each group is in precedence order. */
export function contextualPromptsBySlot(
  context: AgentPageContext,
  now: number
): Record<PromptSlot, SuggestedPrompt[]> {
  const bySlot: Record<PromptSlot, SuggestedPrompt[]> = {
    investigate: [],
    watch: [],
    status: [],
    explain: [],
    docs: [],
  };

  for (const kind of SIGNAL_PRIORITY) {
    for (const signal of context.signals) {
      if (signal.kind !== kind) continue;
      const prompt = promptForSignal(signal, now);
      if (prompt) bySlot[SIGNAL_SLOT[kind]].push(prompt);
    }
  }

  return bySlot;
}
