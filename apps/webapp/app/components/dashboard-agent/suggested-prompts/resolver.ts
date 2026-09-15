/**
 * Turns a page context into the chips the panel shows: the promoted slot, then
 * `PROMPT_SLOTS` in order, signal chips ahead of the page-kind default per slot.
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

// Internal: `ResolvedSuggestedPrompt` carries it, so nothing outside needs the name.
type ResolvedPromptSlot = "promoted" | PromptSlot;

/** Slots survive resolution so callers can keep at most one prompt per slot; they carry no styling. */
export type ResolvedSuggestedPrompt = {
  slot: ResolvedPromptSlot;
  prompt: SuggestedPrompt;
};

export type ResolveSuggestedPromptsOptions = {
  /** Taken as-is; `source` is forced to `promoted`. */
  promoted?: SuggestedPrompt;
  dismissedIds?: string[];
  now?: number;
  /** The `watch` slot is withheld unless explicitly enabled: omitting this must not reintroduce watch prompts. */
  watchEnabled?: boolean;
};

export function resolveSuggestedPrompts(
  context: AgentPageContext,
  opts: ResolveSuggestedPromptsOptions = {}
): SuggestedPrompt[] {
  return resolveSuggestedPromptsBySlot(context, opts).map((resolved) => resolved.prompt);
}

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

  if (opts.promoted) {
    take("promoted", [{ ...opts.promoted, source: "promoted" }]);
  }

  const watchEnabled = opts.watchEnabled ?? false;
  for (const slot of PROMPT_SLOTS) {
    if (slot === "watch" && !watchEnabled) continue;
    take(slot, [...contextual[slot], pageSlots[slot]]);
  }

  // Over the cap, optional slots yield in this order; promoted, explain and docs never yield.
  const yieldOrder: ResolvedPromptSlot[] = ["status", "watch", "investigate"];
  let trimmed = resolved;
  for (const slot of yieldOrder) {
    if (trimmed.length <= SUGGESTED_PROMPT_CAP) break;
    trimmed = trimmed.filter((entry) => entry.slot !== slot);
  }
  return trimmed.slice(0, SUGGESTED_PROMPT_CAP);
}

export function makeSuggestedPromptResolver(
  opts: ResolveSuggestedPromptsOptions = {}
): SuggestedPromptResolver {
  return (context) => resolveSuggestedPrompts(context, opts);
}
