import { agentIntentSchema } from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import { scheduleWatchSchema } from "./tool-schemas";
import { isEnvUnavailable, NO_AUTH, type DashboardAgentApiClient } from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";

/** The watch-facing tool set. Everything watch-specific the agent can call lives here. */
export function buildWatchTools(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
}): ToolSet {
  const { ctx, client } = args;

  return {
    // Proposes a watch, never creates one: the user confirming the card is what starts
    // it, so the card owns consent, the cap and dedup.
    schedule_watch: tool({
      ...scheduleWatchSchema,
      execute: async ({ watch, project, environment, branch }) => {
        let target: { projectRef: string; environmentId: string } | undefined;

        // Only reached to spend a network call: the current-environment path (no
        // override) stays pure schema validation, unchanged from before.
        if (project || environment || branch) {
          if (!client.hasAuth) return NO_AUTH;
          const projectRef = project ?? ctx.projectRef;
          if (!projectRef) {
            return { error: "No project is available to resolve that watch target." };
          }
          const resolved = await client.resolveEnvironmentId({
            projectRef: project,
            environmentName: environment,
            branch,
          });
          if (isEnvUnavailable(resolved)) {
            if (resolved.envUnavailable === "missing") {
              return { error: "No project/environment is available to watch there." };
            }
            const status = resolved.status ? ` (status ${resolved.status})` : "";
            return { error: `Couldn't reach that project/environment to watch it${status}.` };
          }
          target = { projectRef, environmentId: resolved.environmentId };
        }

        // Re-validated through the intent schema, so a rejected spec becomes a tool
        // error rather than an intent the host drops.
        try {
          return { intent: agentIntentSchema.parse({ kind: "watch", spec: watch, target }) };
        } catch (error) {
          return { error: `Couldn't build that watch: ${(error as Error).message}` };
        }
      },
    }),
  };
}
