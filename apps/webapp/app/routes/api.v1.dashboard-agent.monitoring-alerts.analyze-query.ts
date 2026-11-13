import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import {
  authenticateDashboardAgent,
  authorizeAlerts,
  gateMonitoringAlerts,
} from "~/services/dashboardAgentMonitoringAlerts.server";
import { authorizeAgentEnvironmentById } from "~/services/dashboardAgentChatContext.server";
import { querySchemas } from "~/v3/querySchemas";
import { MonitoringAlertsAnalyzeBodySchema } from "~/v3/services/alerts/monitoringAlertsSchemas";
import {
  analyzeQueryForAlert,
  toQuerySignal,
} from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await authenticateDashboardAgent(request);
  if ("error" in auth) return auth.error;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: "Invalid request" }, { status: 400 });
  }
  const body = MonitoringAlertsAnalyzeBodySchema.safeParse(rawBody);
  if (!body.success) {
    return json({ error: "Invalid request", issues: body.error.issues }, { status: 400 });
  }

  const environment = await authorizeAgentEnvironmentById({
    userId: auth.userId,
    environmentId: auth.environmentId,
  });
  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }
  if (!(await gateMonitoringAlerts(environment, auth.userId))) {
    return json({ error: "Monitoring alerts are not enabled for this project" }, { status: 403 });
  }

  const denied = await authorizeAlerts(request, environment, "read");
  if (denied) return denied;

  const analysis = analyzeQueryForAlert(body.data.query.trim(), {
    tableSchemas: querySchemas,
    flags: { QUEUE_METRICS: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1" },
  });

  const choice = body.data.signal;
  if (!choice) return json({ analysis });
  const reasons = [...analysis.errors, ...analysis.unsupported].map((issue) => issue.message);
  const result = analysis.ok
    ? toQuerySignal(analysis, choice)
    : { ok: false as const, message: [...new Set(reasons)].join("; ") };
  return json({
    analysis,
    signal: result.ok ? { ok: true } : { ok: false, message: result.message },
  });
}
