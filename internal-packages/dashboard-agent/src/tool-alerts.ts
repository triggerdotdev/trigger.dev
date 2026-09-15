import { tool, type ToolSet } from "ai";
import { createAlertSchema, deleteAlertSchema, listAlertsSchema } from "./tool-schemas";
import { NO_AUTH, type DashboardAgentApiClient } from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";

/**
 * The alert tools and the request helper they share. Project-level, so these use the
 * delegated token and never the env JWT, and a 403 is a capability refusal to explain.
 */
export function buildAlertTools(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
}): ToolSet {
  const { ctx, client } = args;
  const { userActorToken } = ctx;
  const { origin, hasAuth } = client;

  async function alertsRequest(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<{ data: unknown } | { error: string }> {
    let res: Response;
    try {
      res = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${userActorToken!}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return { error: `Couldn't reach the alerts API: ${(error as Error).message}` };
    }

    const data = (await res.json().catch(() => undefined)) as
      | { error?: string; code?: string }
      | undefined;

    // 403 is a capability refusal and `code` says which one.
    if (res.status === 403) {
      return {
        error:
          data?.code === "email_alerts_not_configured"
            ? "Email delivery isn't set up on this instance, so an email alert can't be created. Tell the user that, and that watch results still show in the dashboard."
            : "Email alerts aren't enabled here. Tell the user that, and that watch results still show in the dashboard.",
      };
    }
    if (res.status === 400 && data?.code === "email_not_allowed") {
      return { error: data.error ?? "Alerts can only go to the user's own account email." };
    }
    if (!res.ok) {
      return { error: data?.error ?? `The alerts API failed (status ${res.status}).` };
    }
    return { data };
  }

  return {
    // Project-level, so these use the delegated token, not the env JWT. Every call
    // carries the chat id, which is what the API scopes its authorization through.
    list_alerts: tool({
      ...listAlertsSchema,
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to read alerts from." };
        const result = await alertsRequest(
          "GET",
          `/api/v1/dashboard-agent/alerts?chatId=${encodeURIComponent(ctx.chatId)}`
        );
        if ("error" in result) return result;
        const alerts = (result.data as { alerts?: unknown } | undefined)?.alerts;
        return { alerts: Array.isArray(alerts) ? alerts : [] };
      },
    }),

    create_alert: tool({
      ...createAlertSchema,
      execute: async ({ email }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to create an alert from." };
        const result = await alertsRequest("POST", "/api/v1/dashboard-agent/alerts", {
          chatId: ctx.chatId,
          channel: "email",
          ...(email ? { email } : {}),
        });
        if ("error" in result) return result;
        // The route's body is the channel itself, not an envelope around one.
        return { created: true, alert: result.data };
      },
    }),

    delete_alert: tool({
      ...deleteAlertSchema,
      execute: async ({ alertId }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to change alerts from." };
        const result = await alertsRequest(
          "DELETE",
          `/api/v1/dashboard-agent/alerts/${encodeURIComponent(alertId)}`,
          { chatId: ctx.chatId }
        );
        if ("error" in result) return result;
        return { deleted: true, alertId };
      },
    }),
  };
}
