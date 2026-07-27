/**
 * Parsing the promoted-slot flag value.
 *
 * Split out of `promotedPrompt.server.ts` so the parsing (the part with rules
 * worth testing) doesn't drag in prisma and `env.server`.
 */
import { suggestedPromptSchema, type SuggestedPrompt } from "@internal/dashboard-agent-contracts";

/** `source` is set here, so the stored JSON doesn't have to carry it. */
const promotedPromptSchema = suggestedPromptSchema.omit({ source: true }).extend({
  id: suggestedPromptSchema.shape.id.min(1),
  label: suggestedPromptSchema.shape.label.min(1),
  prompt: suggestedPromptSchema.shape.prompt.min(1),
});

/**
 * The promoted chip from a stored flag value, or undefined for anything
 * malformed — a typo in the admin field must cost a chip, not the panel.
 */
export function parsePromotedPrompt(value: unknown): SuggestedPrompt | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;

  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return undefined;
  }

  const parsed = promotedPromptSchema.safeParse(json);
  return parsed.success ? { ...parsed.data, source: "promoted" } : undefined;
}
