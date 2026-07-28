/**
 * Suggested prompts — the chips offered in the panel. This file is SHAPE ONLY:
 * types, schema, and the display cap. No registry contents and no resolution
 * behavior live here; a host supplies a resolver matching {@link SuggestedPromptResolver}.
 */
import type { AgentPageContext } from "./page-context.js";
import { z } from "zod";

export const suggestedPromptSchema = z.object({
  /** Stable id, so a chip can be tracked across renders and re-resolutions. */
  id: z.string(),
  /** Short chip text. */
  label: z.string(),
  /** The message actually sent when the chip is clicked. */
  prompt: z.string(),
  /**
   * - `default` — always available, page-independent.
   * - `contextual` — derived from the current page or its signals.
   * - `promoted` — deliberately surfaced ahead of the rest.
   */
  source: z.enum(["default", "contextual", "promoted"]),
});

export type SuggestedPrompt = z.infer<typeof suggestedPromptSchema>;

/**
 * Never show more than this many chips at once: the promoted slot plus the four
 * slots the host's resolver fills (investigate, watch, explain, docs).
 */
export const SUGGESTED_PROMPT_CAP = 5;

export type SuggestedPromptResolver = (context: AgentPageContext) => SuggestedPrompt[];
