/** An intent is a request to the host, never an action. The host decides. */
import { runFiltersSchema } from "./run-filters.js";
import { triggerUriSchema } from "./trigger-uri.js";
import { watchSpecSchema } from "./watch.js";
import { z } from "zod";

export const agentIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("navigate"),
    target: triggerUriSchema,
    filters: runFiltersSchema.optional(),
  }),
  z.object({ kind: z.literal("ask"), prompt: z.string() }),
  z.object({ kind: z.literal("watch"), spec: watchSpecSchema }),
  /** Reserved: nothing may emit or execute this until write actions ship. */
  z.object({ kind: z.literal("propose_fix"), investigationId: z.string() }),
]);

export type AgentIntent = z.infer<typeof agentIntentSchema>;
export type AgentIntentKind = AgentIntent["kind"];

export function isExecutableIntent(intent: AgentIntent): boolean {
  return intent.kind !== "propose_fix";
}
