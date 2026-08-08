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

/** A kind with no entry produces no chip. */
export const SIGNAL_SLOT: Partial<Record<AgentPageSignalKind, PromptSlot>> = {
  fresh_failure: "investigate",
  slow_run: "investigate",
};

/** Signal precedence within a slot. */
export const SIGNAL_PRIORITY: AgentPageSignalKind[] = ["fresh_failure", "slow_run"];

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

    case "slow_run": {
      if (signal.baselineP95Ms <= 0) return undefined;
      const factor = formatMultiplier(signal.durationMs / signal.baselineP95Ms);
      return ctx(
        "slow-run",
        `~${factor} slower than usual`,
        `${signal.runId} is running ~${factor} slower than this task's usual p95. Investigate why.`
      );
    }
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
    status: [],
    explain: [],
    docs: [],
  };

  for (const kind of SIGNAL_PRIORITY) {
    const slot = SIGNAL_SLOT[kind];
    if (!slot) continue;
    for (const signal of context.signals) {
      if (signal.kind !== kind) continue;
      const prompt = promptForSignal(signal, now);
      if (prompt) bySlot[slot].push(prompt);
    }
  }

  return bySlot;
}
