/**
 * Agent intents — what the agent wants the host to do next. The host decides
 * whether to honour an intent; emitting one is a request, never an action.
 */
import { runFiltersSchema } from "./run-filters.js";
import { triggerUriSchema } from "./trigger-uri.js";
import { z } from "zod";

export const agentIntentSchema = z.discriminatedUnion("kind", [
  /** Take the user to a resource, optionally with runs-list filters applied. */
  z.object({
    kind: z.literal("navigate"),
    target: triggerUriSchema,
    filters: runFiltersSchema.optional(),
  }),
  /** Hand a follow-up question back into the conversation. */
  z.object({ kind: z.literal("ask"), prompt: z.string() }),
  /**
   * RESERVED — DO NOT EMIT OR EXECUTE IN M0–M7.
   *
   * It exists in the union now so the wire format is frozen and stored intents
   * from a future milestone still parse. Until write actions ship, nothing may
   * produce this intent and hosts are expected to reject it explicitly rather
   * than ignore it.
   */
  z.object({ kind: z.literal("propose_fix"), investigationId: z.string() }),
]);

export type AgentIntent = z.infer<typeof agentIntentSchema>;
export type AgentIntentKind = AgentIntent["kind"];

/** True for the intents a host may act on today. */
export function isExecutableIntent(intent: AgentIntent): boolean {
  return intent.kind !== "propose_fix";
}
