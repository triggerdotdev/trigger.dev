import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  alertsInAnyEnvironment,
  canUseMonitoringAlerts,
  findMonitoringAlertsProject,
  monitoringAlertsRouteContext,
} from "~/services/monitoringAlertsApi.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { querySchemas } from "~/v3/querySchemas";
import {
  MonitoringAlertsAnalyzeBodySchema,
  MonitoringAlertsParamsSchema,
} from "~/v3/services/alerts/monitoringAlertsSchemas";
import { analyzeQueryForAlert } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";

export const action = createActionPATApiRoute(
  {
    method: "POST",
    params: MonitoringAlertsParamsSchema,
    context: monitoringAlertsRouteContext,
    authorization: { action: "read", resource: alertsInAnyEnvironment },
  },
  async ({ request, params, authentication }) => {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = MonitoringAlertsAnalyzeBodySchema.safeParse(rawBody);
    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }

    try {
      const project = await findMonitoringAlertsProject(params.projectRef, authentication.userId);
      if (!project) {
        return json({ error: "Project not found" }, { status: 404 });
      }

      if (!(await canUseMonitoringAlerts(project, authentication.userId))) {
        return json(
          { error: "Monitoring alerts are not enabled for this project" },
          { status: 403 }
        );
      }

      const analysis = analyzeQueryForAlert(body.data.query.trim(), {
        tableSchemas: querySchemas,
        flags: { QUEUE_METRICS: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1" },
      });

      return json({ analysis });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to analyze alert query", {
        userId: authentication.userId,
        error,
      });
      throw error;
    }
  }
);
