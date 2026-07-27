/**
 * Turning a page context into the chips the panel shows.
 *
 * Ordering is the whole design: promoted -> contextual -> page defaults, capped
 * at `SUGGESTED_PROMPT_CAP`. So a product-chosen chip always gets the top slot,
 * anything abnormal about the page comes next, and the evergreen questions fill
 * whatever's left. Dismissed chips are dropped before the cap, so dismissing one
 * promotes the next candidate rather than shrinking the row.
 */
import {
  SUGGESTED_PROMPT_CAP,
  type AgentPageContext,
  type SuggestedPrompt,
  type SuggestedPromptResolver,
} from "@internal/dashboard-agent-contracts";
import { contextualPrompts, pageDefaultPrompts } from "./registry";

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
  const now = opts.now ?? Date.now();
  const dismissed = new Set(opts.dismissedIds ?? []);

  const candidates: SuggestedPrompt[] = [
    // Whatever the flag says, it occupies the promoted slot — the caller doesn't
    // have to remember to set `source`.
    ...(opts.promoted ? [{ ...opts.promoted, source: "promoted" as const }] : []),
    ...contextualPrompts(context, now),
    ...pageDefaultPrompts(context.page),
  ];

  const resolved: SuggestedPrompt[] = [];
  const seen = new Set<string>();

  for (const prompt of candidates) {
    if (dismissed.has(prompt.id) || seen.has(prompt.id)) continue;
    seen.add(prompt.id);
    resolved.push(prompt);
    if (resolved.length === SUGGESTED_PROMPT_CAP) break;
  }

  return resolved;
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
