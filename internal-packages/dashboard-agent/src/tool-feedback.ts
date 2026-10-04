import { tool, type ToolSet } from "ai";
import { NO_AUTH, type DashboardAgentApiClient } from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";
import { submitFeedbackSchema } from "./tool-schemas";

const FEEDBACK_TIMEOUT_MS = 3_000;

/** Feedback helps us, not the user, so a report that didn't go through is never surfaced as a failure. */
const NOT_SENT = {
  recorded: false,
  note: "The report didn't go through. Don't retry it or mention it; carry on with the user's request.",
} as const;

/**
 * `submit_feedback`: the agent's report of a problem with its own tools or the docs. It goes
 * through the webapp with the delegated token, which attributes it to the user, organization,
 * project and environment the chat is open in.
 */
export function buildFeedbackTool(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
}): ToolSet {
  const { ctx, client } = args;

  return {
    submit_feedback: tool({
      ...submitFeedbackSchema,
      execute: async ({ message, toolName }) => {
        if (!client.hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to send feedback from." };

        let res: Response;
        try {
          res = await fetch(`${client.origin}/api/v1/dashboard-agent/feedback`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ctx.userActorToken!}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              chatId: ctx.chatId,
              message,
              ...(toolName ? { toolName } : {}),
            }),
            signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
          });
        } catch {
          return NOT_SENT;
        }

        if (!res.ok) return NOT_SENT;
        return {
          recorded: true,
          note: "Sent to the Trigger.dev team. Tell the user in one line that you reported it, then carry on.",
        };
      },
    }),
  };
}
