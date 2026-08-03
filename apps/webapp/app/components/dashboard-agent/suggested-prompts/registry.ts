/**
 * The suggested-prompt registry: the chips the panel can offer, and the rules
 * that pick them.
 *
 * The row is a discoverability surface, so it's built from fixed slots rather
 * than a ranked pile:
 *
 * - `investigate` — "something is wrong, dig in". Filled by a fresh_failure or
 *   slow_run signal, or by the page kind when the page is inherently about a
 *   failure (an error or a single run).
 * - `watch` — "tell me when this changes". Filled by a waiting_run or
 *   saturation signal, or by a queue/error page.
 * - `explain` — the evergreen explain/find/show question. Always present.
 * - `docs` — a doc-flavored "how do I …". Always present, always last.
 *
 * A signal only exists for abnormal state (the route `handle` mappers enforce
 * that), so an `investigate`/`watch` chip appearing is itself the news. Wording
 * follows the demo fixtures (`demo/fixtures/page-context.ts`), which is the
 * review-approved copy.
 *
 * `resolver.ts` orders the slots and applies the cap. This file is pure: no
 * React, no server imports, no clock beyond the `now` passed in.
 */
import type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
  AgentPageSignalKind,
  SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";
// The dashboard's own Investigate-button copy: same question, so same wording.
import { queueBacklogPrompt } from "../investigate-prompts";

/**
 * Chip ids are stable and carry no run/queue identity, on purpose: a dismissal
 * is stored by id, and an id like `fresh-failure:run_abc` would make "don't show
 * me this again" mean "don't show me this again for this one run" — which is the
 * same as not persisting at all. Identity lives in the prompt text instead.
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

/**
 * The slot a page kind can fill. `explain` and `docs` are required — every page
 * must be able to fill the last two slots.
 */
export type PageSlotPrompts = {
  investigate?: SuggestedPrompt;
  watch?: SuggestedPrompt;
  status?: SuggestedPrompt;
  explain: SuggestedPrompt;
  docs: SuggestedPrompt;
};

// ---------------------------------------------------------------------------
// Page-independent chips, for pages we haven't classified.
// ---------------------------------------------------------------------------

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
/** Shared by the errors list and an error group — same subject, same docs. */
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

/**
 * `WorkerDeploymentStatus` values that mean "this deploy didn't land". A
 * canceled deploy is deliberate, so it isn't one of them.
 */
const FAILED_DEPLOYMENT_STATUSES = new Set(["FAILED", "TIMED_OUT"]);

/** Whether a deployment status is one the agent can investigate. */
export function isFailedDeploymentStatus(status: string | undefined): boolean {
  return status !== undefined && FAILED_DEPLOYMENT_STATUSES.has(status);
}

/** The slots an unclassified page fills: explain, then docs. */
export const GENERIC_PROMPTS: SuggestedPrompt[] = [EXPLAIN_PAGE, DOCS_GENERIC];

// ---------------------------------------------------------------------------
// Page-kind slots. What to ask on this kind of page when nothing is wrong.
// ---------------------------------------------------------------------------

/** The slot chips a page kind can fill, before signals and the promoted slot. */
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
        // The fingerprint is a hash, so the chip says "this error" and lets the
        // agent read the identity off the page context.
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
        // The page shows warn/crit itself (the health badge, the Investigate
        // button); a healthy queue has nothing to dig into.
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
        // Only a deployment that didn't land has something to investigate.
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

    case "other":
      return { explain: EXPLAIN_PAGE, docs: DOCS_GENERIC };
  }
}

/**
 * The page's slot chips as a flat list in display order. Slots the page can't
 * fill are simply absent — the row collapses rather than padding itself.
 */
export function pageDefaultPrompts(page: AgentPage): SuggestedPrompt[] {
  const slots = pageSlotPrompts(page);
  return PROMPT_SLOTS.map((slot) => slots[slot]).filter(
    (prompt): prompt is SuggestedPrompt => prompt !== undefined
  );
}

// ---------------------------------------------------------------------------
// Contextual prompts, one per signal.
// ---------------------------------------------------------------------------

/** Which slot a signal's chip competes for. */
export const SIGNAL_SLOT: Record<AgentPageSignalKind, PromptSlot> = {
  fresh_failure: "investigate",
  slow_run: "investigate",
  waiting_run: "watch",
  concurrency_saturation: "watch",
};

/**
 * Signal precedence within a slot. `fresh_failure` wins: a run that just failed
 * is why the user opened the panel. Mirrors `demoSignalsByPriority` in the
 * fixtures.
 */
export const SIGNAL_PRIORITY: AgentPageSignalKind[] = [
  "fresh_failure",
  "waiting_run",
  "slow_run",
  "concurrency_saturation",
];

/** "3m", "2h", "4d" — coarse on purpose, this is chip copy. */
export function formatAgo(ms: number): string {
  if (ms < 60_000) return "moments";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** "2.4x" under 10x, "31x" above — one decimal only where it means something. */
export function formatMultiplier(factor: number): string {
  return factor < 10 ? `${factor.toFixed(1)}x` : `${Math.round(factor)}x`;
}

/**
 * The chip for one signal, or undefined when the signal doesn't carry enough to
 * say anything useful (a slow_run with no baseline, say).
 */
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

/** Contextual chips for a context's signals, in precedence order. */
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

/**
 * Contextual chips grouped by the slot they compete for, each group in
 * precedence order.
 */
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
