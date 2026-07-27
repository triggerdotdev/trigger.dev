/**
 * The suggested-prompt registry: the chips the panel can offer, and the rules
 * that pick them.
 *
 * Two sources, no LLM and no queries:
 *
 * - **Page-kind defaults** — what's worth asking on a runs list vs. a queue vs.
 *   a deployment. Wording comes from the demo fixtures
 *   (`demo/fixtures/page-context.ts`), which is the review-approved copy, so the
 *   gallery and the panel can't disagree about what a chip says.
 * - **Contextual prompts** — one per signal the page emitted. A signal only
 *   exists for abnormal state (the route `handle` mappers enforce that), so a
 *   contextual chip appearing is itself the news.
 *
 * `resolver.ts` orders and caps them. This file is pure: no React, no server
 * imports, no clock beyond the `now` passed in.
 */
import type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
  AgentPageSignalKind,
  SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";

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

// ---------------------------------------------------------------------------
// Page-independent defaults. The tail of every page's chip list.
// ---------------------------------------------------------------------------

const CAPABILITIES = def(
  "capabilities",
  "What can you help me with?",
  "What can you help me with?"
);
const RETRIES = def("retries", "How do retries work?", "How do retries work in Trigger.dev?");
const ENV_HEALTH = def(
  "env-health",
  "How's my environment?",
  "Give me a health report for this environment."
);

/** Always-available, page-independent chips, in offer order. */
export const GENERIC_PROMPTS: SuggestedPrompt[] = [CAPABILITIES, RETRIES, ENV_HEALTH];

// ---------------------------------------------------------------------------
// Page-kind defaults. What to ask on this kind of page when nothing is wrong.
// ---------------------------------------------------------------------------

/**
 * The chips for a page, before signals and before the promoted slot. Ends with
 * the generic set so a short page-specific list still fills the row.
 */
export function pageDefaultPrompts(page: AgentPage): SuggestedPrompt[] {
  switch (page.kind) {
    case "runs":
      return [
        def(
          "runs-failure-pattern",
          "What's failing most?",
          "Which tasks are failing most in the last 24 hours?"
        ),
        def(
          "runs-chart-failures",
          "Chart the failures",
          "Chart failed runs per hour by task over the last 24 hours."
        ),
        ENV_HEALTH,
        CAPABILITIES,
      ];

    case "run":
      return [
        def("run-summarize", "What did this run do?", `Summarize what ${page.runId} did.`),
        def(
          "run-task-health",
          "Is this task healthy?",
          `How has ${page.taskId} been performing recently?`
        ),
        RETRIES,
        CAPABILITIES,
      ];

    case "error":
      return [
        def(
          "error-explain",
          "Explain this error",
          "Explain this error and what usually causes it."
        ),
        def(
          "error-watch-recurrence",
          "Tell me if it comes back",
          "Watch this error and tell me if it happens again."
        ),
        RETRIES,
        CAPABILITIES,
      ];

    case "queue":
      return [
        def(
          "queue-state",
          "How is this queue doing?",
          `Explain the current state of the ${page.name} queue.`
        ),
        def(
          "queue-raise-limit",
          "Should I raise the limit?",
          "Should I raise the concurrency limit on this queue?"
        ),
        ENV_HEALTH,
        CAPABILITIES,
      ];

    case "deployment":
      return [
        def(
          "deployment-diff",
          "What changed in this deploy?",
          `What changed in deployment ${page.version}?`
        ),
        CAPABILITIES,
        RETRIES,
      ];

    case "other":
      return GENERIC_PROMPTS;
  }
}

// ---------------------------------------------------------------------------
// Contextual prompts, one per signal.
// ---------------------------------------------------------------------------

/**
 * Signal precedence. `fresh_failure` wins: a run that just failed is why the
 * user opened the panel. Mirrors `demoSignalsByPriority` in the fixtures.
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
        "Why is this run waiting?",
        signal.queue
          ? `Why is ${signal.runId} still waiting in the ${signal.queue} queue?`
          : `Why is ${signal.runId} still waiting?`
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
        "Explain current saturation",
        "Concurrency is saturated right now. Explain what's causing it and what I should do."
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
