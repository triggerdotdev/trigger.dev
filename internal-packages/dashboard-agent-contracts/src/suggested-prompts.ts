/** Shape only. The registry contents and resolution behavior live in the host. */
import type { AgentPageContext } from "./page-context.js";
import { z } from "zod";

export const suggestedPromptSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The message sent when the chip is clicked. */
  prompt: z.string(),
  source: z.enum(["default", "contextual", "promoted"]),
});

export type SuggestedPrompt = z.infer<typeof suggestedPromptSchema>;

export const SUGGESTED_PROMPT_CAP = 5;

export type SuggestedPromptResolver = (context: AgentPageContext) => SuggestedPrompt[];
