/**
 * Turning a page context into the chips the panel shows.
 *
 * The row is a fixed set of slots, in this order:
 *
 * 1. `promoted` — the product-chosen chip, when one is configured.
 * 2. `investigate` — when the page or its signals make one relevant.
 * 3. `status` — when the page has something live worth asking about (a waiting
 *    run, a saturated queue, a recurring error).
 * 4. `explain` — the evergreen explain/find/show question. Always present.
 * 5. `docs` — a doc-flavored question. Always present, always last.
 *
 * Slots nothing can fill collapse, so the row shows what exists rather than
 * padding itself. Each slot has an ordered candidate list (signal chips first,
 * then the page-kind default), so dismissing a chip promotes the next candidate
 * for that slot instead of leaving a hole.
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
 * A resolved prompt with the slot it filled. The slot is what the blank-state
 * hero styles each prompt button by (see `PROMPT_SLOT_BUTTON`), so it has to
 * survive resolution — a `SuggestedPrompt` on its own can't say whether it is an
 * investigate or a docs question.
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
 * this with the slots dropped, so the two can never disagree about ordering or
 * the cap.
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

  // Whatever the flag says, it occupies the promoted slot — the caller doesn't
  // have to remember to set `source`.
  if (opts.promoted) {
    take("promoted", [{ ...opts.promoted, source: "promoted" }]);
  }

  for (const slot of PROMPT_SLOTS) {
    take(slot, [...contextual[slot], pageSlots[slot]]);
  }

  return resolved.slice(0, SUGGESTED_PROMPT_CAP);
}

/**
 * The contract's resolver shape, with the promoted slot and dismissals bound.
 * Lets a caller that only has a page context (the prompts component) hold a
 * plain `(context) => prompts` function.
 */
export function makeSuggestedPromptResolver(
  opts: ResolveSuggestedPromptsOptions = {}
): SuggestedPromptResolver {
  return (context) => resolveSuggestedPrompts(context, opts);
}
