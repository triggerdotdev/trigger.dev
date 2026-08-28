import {
  agentIntentSchema,
  formatTriggerUri,
  type ParsedTriggerUri,
} from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import { getCurrentPageSchema, navigateToSchema } from "./tool-schemas";
import type { DashboardAgentToolContext } from "./tool-context";

/** Where the user is, and where the agent can send them. No fetch, no auth. */
export function buildNavigationTools(ctx: DashboardAgentToolContext): ToolSet {
  const { projectRef } = ctx;

  return {
    // Context tools: no fetch, no auth.
    get_current_page: tool({
      ...getCurrentPageSchema,
      execute: async () => {
        if (ctx.pageContext) {
          return {
            page: ctx.pageContext.page,
            signals: ctx.pageContext.signals,
            path: ctx.currentPage,
          };
        }
        // Older turns (and unclassified routes) carry only the raw path.
        if (ctx.currentPage) {
          return { page: { kind: "other", path: ctx.currentPage }, signals: [] };
        }
        return {
          page: null,
          signals: [],
          note: "This turn carried no page context, so ask the user what they're looking at.",
        };
      },
    }),

    navigate_to: tool({
      ...navigateToSchema,
      execute: async ({ destination }) => {
        if (!projectRef || !ctx.environmentId) {
          return {
            error:
              "No current project and environment for this turn, so there's nowhere to navigate to. Tell the user what to look at instead.",
          };
        }
        const scope = { projectRef, environmentId: ctx.environmentId };

        let parsed: ParsedTriggerUri;
        switch (destination.kind) {
          case "runs":
            // Filters ride in the intent, not the URI.
            parsed = { kind: "runs", ...scope };
            break;
          case "run":
            parsed = { kind: "run", ...scope, runId: destination.runId };
            break;
          case "error":
            // The API's friendly id is accepted; the page keys on the raw one.
            parsed = {
              kind: "error",
              ...scope,
              fingerprint: destination.fingerprint.replace(/^error_/, ""),
            };
            break;
          case "queue":
            parsed = { kind: "queue", ...scope, name: destination.name };
            break;
          case "deployment":
            parsed = { kind: "deployment", ...scope, version: destination.version };
            break;
        }

        // Re-validated through the intent schema, so a malformed id becomes a tool error
        // rather than an intent the host must reject.
        try {
          const intent = agentIntentSchema.parse({
            kind: "navigate",
            target: formatTriggerUri(parsed),
            ...(destination.kind === "runs" && destination.filters
              ? { filters: destination.filters }
              : {}),
          });
          return destination.kind === "runs"
            ? { intent, appliedFilters: destination.filters ?? {} }
            : { intent };
        } catch (error) {
          return { error: `Couldn't build a link for that: ${(error as Error).message}` };
        }
      },
    }),
  };
}
