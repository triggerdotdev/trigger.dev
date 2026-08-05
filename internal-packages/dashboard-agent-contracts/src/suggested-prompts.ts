/**
 * Suggested prompts — the chips offered in the panel. Shape only: types, schema
 * and the display cap. The registry contents and the resolution behavior live in
 * the host, which supplies a {@link SuggestedPromptResolver}.
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

/** The promoted slot plus the four the host's resolver fills. */
export const SUGGESTED_PROMPT_CAP = 5;

export type SuggestedPromptResolver = (context: AgentPageContext) => SuggestedPrompt[];
