/**
 * Chips a page's live signals produce, and how they order within a slot. `undefined`
 * means the signal lacks the data to say anything.
 */
import type {
  AgentPageContext,
  AgentPageSignal,
  AgentPageSignalKind,
  SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";
import { ctx, type PromptSlot } from "./prompt-chips";

const SIGNAL_SLOT: Record<AgentPageSignalKind, PromptSlot> = {
  fresh_failure: "investigate",
  slow_run: "investigate",
  waiting_run: "watch",
  concurrency_saturation: "watch",
};

/** Signal precedence within a slot. Mirrors `demoSignalsByPriority` in the fixtures. */
const SIGNAL_PRIORITY: AgentPageSignalKind[] = [
  "fresh_failure",
  "waiting_run",
  "slow_run",
  "concurrency_saturation",
];

/** "3m", "2h", "4d". */
function formatAgo(ms: number): string {
  if (ms < 60_000) return "moments";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** "2.4x" under 10x, "31x" above. */
function formatMultiplier(factor: number): string {
  return factor < 10 ? `${factor.toFixed(1)}x` : `${Math.round(factor)}x`;
}

/** Undefined when the signal lacks the data to say anything, e.g. a `slow_run` with no baseline. */
function promptForSignal(signal: AgentPageSignal, now: number): SuggestedPrompt | undefined {
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

    case "concurrency_saturation": {
      const why =
        signal.scope === "queue" && signal.queueName
          ? `Why is the ${signal.queueName} queue at its concurrency limit?`
          : "Concurrency is saturated right now.";
      return ctx(
        "concurrency-saturation",
        "Tell me when the backlog drains",
        `${why} Watch it and tell me when the backlog drains.`
      );
    }
  }
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
