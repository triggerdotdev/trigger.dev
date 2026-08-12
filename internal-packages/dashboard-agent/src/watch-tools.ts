import { agentIntentSchema } from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import { scheduleWatchSchema } from "./tool-schemas";

/** The watch-facing tool set. Everything watch-specific the agent can call lives here. */
export function buildWatchTools(): ToolSet {
  return {
    // Proposes a watch, never creates one: the user confirming the card is what starts
    // it, so the card owns consent, the cap and dedup.
    schedule_watch: tool({
      ...scheduleWatchSchema,
      execute: async ({ watch }) => {
        // Re-validated through the intent schema, so a rejected spec becomes a tool
        // error rather than an intent the host drops.
        try {
          return { intent: agentIntentSchema.parse({ kind: "watch", spec: watch }) };
        } catch (error) {
          return { error: `Couldn't build that watch: ${(error as Error).message}` };
        }
      },
    }),
  };
}
