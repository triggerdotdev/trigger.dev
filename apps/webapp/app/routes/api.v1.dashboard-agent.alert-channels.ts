import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { resolveAgentAlertContext } from "~/services/dashboardAgentAlertContext.server";
import {
  alertReadAbility,
  authenticateDashboardAgent,
  authorizeAlerts,
  gateMonitoringAlerts,
} from "~/services/dashboardAgentMonitoringAlerts.server";
import {
  AGENT_ALERT_CHANNEL_SCOPES,
  listScopedAlertChannels,
} from "~/v3/services/alerts/agentAlertScope.server";

const QuerySchema = z.object({
  chatId: z.string().min(1),
  scope: z.enum(AGENT_ALERT_CHANNEL_SCOPES).default("project"),
  type: z.enum(["EMAIL", "SLACK", "WEBHOOK"]).optional(),
  legacy: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await authenticateDashboardAgent(request);
  if ("error" in auth) return auth.error;

  const query = QuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries())
  );
  if (!query.success) {
    return json({ error: "Invalid request" }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({
    userId: auth.userId,
    environmentId: auth.environmentId,
    chatId: query.data.chatId,
  });
  if (!context.ok) {
    return json(
      { error: context.error, code: context.code },
      { status: context.code === "environment_mismatch" ? 400 : 404 }
    );
  }
  const { environment } = context;

  if (!(await gateMonitoringAlerts(environment, auth.userId))) {
    return json({ error: "Monitoring alerts are not enabled for this project" }, { status: 403 });
  }

  const denied = await authorizeAlerts(request, environment, "read");
  if (denied) return denied;

  const { channels, truncated } = await listScopedAlertChannels(
    prisma,
    {
      origin: {
        userId: auth.userId,
        organizationId: environment.organizationId,
        projectId: environment.project.id,
        environmentId: environment.id,
      },
      scope: query.data.scope,
      type: query.data.type,
      legacy: query.data.legacy,
    },
    alertReadAbility(request, environment.organizationId)
  );

  return json({ scope: query.data.scope, channels, truncated });
}
