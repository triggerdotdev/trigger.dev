import { chat, type ActionTurn } from "@trigger.dev/sdk/ai";
import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";
import type { AlertInvestigateContext } from "@internal/dashboard-agent-contracts";

export type AlertInvestigateAction = {
  type: "alert.investigate";
  id: string;
  alertId: string;
  context: AlertInvestigateContext;
};

export const alertInvestigateActionSchema = z.object({
  type: z.literal("alert.investigate"),
  id: z.string(),
  alertId: z.string(),
  context: z.object({
    alertId: z.string(),
    capabilityKey: z.string(),
    environmentId: z.string(),
    scope: z
      .object({
        type: z.string(),
        queue: z.string().optional(),
        pattern: z.string().optional(),
        taskIdentifier: z.string().optional(),
      })
      .optional(),
    facts: z.record(z.string(), z.unknown()),
    timeWindow: z.object({ startAt: z.string(), endAt: z.string() }).optional(),
  }),
});

/**
 * Every action the agent accepts. Anything else fails to parse and never reaches a handler.
 *
 * The trust boundary is the STREAM, not the schema. `.in` records are written
 * with an environment secret key or from the dashboard's own server-side hop,
 * and the `in` proxy refuses to forward a browser-supplied `trigger: "action"`.
 */
export const dashboardAgentActionSchema = alertInvestigateActionSchema;

export type DashboardAgentAction = AlertInvestigateAction;

async function* fixedNarrationChunks(
  messageId: string,
  text: string
): AsyncGenerator<UIMessageChunk> {
  yield { type: "start", messageId };
  yield { type: "text-start", id: "wake" };
  yield { type: "text-delta", id: "wake", delta: text };
  yield { type: "text-end", id: "wake" };
  yield { type: "finish" };
}

export async function handleAction(args: {
  action: unknown;
  uiMessages: UIMessage[];
}): Promise<ActionTurn | undefined> {
  const { uiMessages } = args;
  const typed = args.action as DashboardAgentAction;
  const msgId = `alert:${typed.alertId}:investigate`;
  if (!uiMessages.some((m) => m.id === msgId)) {
    const text = "Alert investigation is not available yet.";
    await chat.pipe(fixedNarrationChunks(msgId, text));
    chat.history.set([
      ...uiMessages,
      { id: msgId, role: "assistant", parts: [{ type: "text", text }] },
    ]);
  }
  return undefined;
}
