/**
 * How a chip is made and which slots exist. Pure: no React, no server imports, no
 * clock beyond the `now` passed in.
 */
import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";

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

export const def = (id: string, label: string, prompt: string) =>
  make(id, label, prompt, "default");
export const ctx = (id: string, label: string, prompt: string) =>
  make(id, label, prompt, "contextual");

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
