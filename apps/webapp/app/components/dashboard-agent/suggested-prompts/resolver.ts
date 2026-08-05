/**
 * Turns a page context into the chips the panel shows. The promoted slot comes
 * first, then `PROMPT_SLOTS` in order. Each slot has an ordered candidate list
 * (signal chips first, then the page-kind default), so dismissing a chip promotes
 * the next candidate for that slot instead of leaving a hole.
 */
import {
  SUGGESTED_PROMPT_CAP,
  type AgentPageContext,
  type SuggestedPrompt,
  type SuggestedPromptResolver,
} from "@internal/dashboard-agent-contracts";
import {
  contextualPromptsBySlot,
  pageSlotPrompts,
  PROMPT_SLOTS,
  type PromptSlot,
} from "./registry";

/** The slot a resolved prompt came from, including the product-chosen one. */
export type ResolvedPromptSlot = "promoted" | PromptSlot;

/**
 * A resolved prompt with the slot it filled. The blank-state hero styles each
 * button by slot (`PROMPT_SLOT_BUTTON`), so the slot has to survive resolution.
 */
export type ResolvedSuggestedPrompt = {
  slot: ResolvedPromptSlot;
  prompt: SuggestedPrompt;
};

export type ResolveSuggestedPromptsOptions = {
  /** The product-controlled slot, taken as-is and forced to `promoted`. */
  promoted?: SuggestedPrompt;
  /** Chip ids this user has dismissed. */
  dismissedIds?: string[];
  /** Injectable clock, so "failed 3m ago" is testable. */
  now?: number;
};

export function resolveSuggestedPrompts(
  context: AgentPageContext,
  opts: ResolveSuggestedPromptsOptions = {}
): SuggestedPrompt[] {
  return resolveSuggestedPromptsBySlot(context, opts).map((resolved) => resolved.prompt);
}

/**
 * The same resolution, keeping each prompt's slot. `resolveSuggestedPrompts` is
 * this with the slots dropped, so the two can't disagree about order or the cap.
 */
export function resolveSuggestedPromptsBySlot(
  context: AgentPageContext,
  opts: ResolveSuggestedPromptsOptions = {}
): ResolvedSuggestedPrompt[] {
  const now = opts.now ?? Date.now();
  const dismissed = new Set(opts.dismissedIds ?? []);

  const contextual = contextualPromptsBySlot(context, now);
  const pageSlots = pageSlotPrompts(context.page);

  const resolved: ResolvedSuggestedPrompt[] = [];
  const seen = new Set<string>();

  const take = (slot: ResolvedPromptSlot, candidates: (SuggestedPrompt | undefined)[]): void => {
    for (const candidate of candidates) {
      if (!candidate || dismissed.has(candidate.id) || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      resolved.push({ slot, prompt: candidate });
      return;
    }
  };

  // `source` is forced here so callers don't have to set it.
  if (opts.promoted) {
    take("promoted", [{ ...opts.promoted, source: "promoted" }]);
  }

  for (const slot of PROMPT_SLOTS) {
    take(slot, [...contextual[slot], pageSlots[slot]]);
  }

  // Over the cap, optional slots yield in this order. Promoted, explain and docs
  // never yield: explain and docs are required on every page, docs stays last.
  const yieldOrder: ResolvedPromptSlot[] = ["status", "watch", "investigate"];
  let trimmed = resolved;
  for (const slot of yieldOrder) {
    if (trimmed.length <= SUGGESTED_PROMPT_CAP) break;
    trimmed = trimmed.filter((entry) => entry.slot !== slot);
  }
  return trimmed.slice(0, SUGGESTED_PROMPT_CAP);
}

/** The contract's resolver shape, with the promoted slot and dismissals bound. */
export function makeSuggestedPromptResolver(
  opts: ResolveSuggestedPromptsOptions = {}
): SuggestedPromptResolver {
  return (context) => resolveSuggestedPrompts(context, opts);
}
