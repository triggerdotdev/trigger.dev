import { json } from "@remix-run/server-runtime";
import { listAlerts } from "~/v3/services/alerts/storage/alertStore.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import {
  alertsInAnyEnvironment,
  alertsEnvironmentForbidden,
  canUseMonitoringAlerts,
  findMonitoringAlertsProject,
  monitoringAlertsRouteContext,
  resolveMonitoringAlertsEnvironment,
} from "~/services/monitoringAlertsApi.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { assertUserActorEnvironment } from "~/services/userActorEnvironment.server";
import { createMonitoringAlertsAction } from "~/v3/services/alerts/createMonitoringAlertsAction.server";
import { alertDisplayName } from "~/v3/services/alerts/alertDisplayName";
import {
  MonitoringAlertsParamsSchema,
  MonitoringAlertsListQuerySchema,
} from "~/v3/services/alerts/monitoringAlertsSchemas";

export const loader = createLoaderPATApiRoute(
  {
    params: MonitoringAlertsParamsSchema,
    context: monitoringAlertsRouteContext,
    authorization: { action: "read", resource: alertsInAnyEnvironment },
  },
  async ({ request, params, authentication, ability }) => {
    const query = MonitoringAlertsListQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!query.success) {
      return json({ error: "Invalid query", issues: query.error.issues }, { status: 400 });
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

      const environment = await resolveMonitoringAlertsEnvironment({
        projectId: project.id,
        environment: query.data.environment,
        branch: query.data.branch,
        userId: authentication.userId,
      });
      if (!environment) {
        return json({ error: "Environment not found" }, { status: 404 });
      }
      assertUserActorEnvironment(authentication.userActor, environment.id);
      if (!ability.can("read", { type: "alerts", envType: environment.type })) {
        return alertsEnvironmentForbidden("read");
      }

      const alerts = await listAlerts(prisma, {
        environmentId: environment.id,
        projectId: project.id,
        lifecycle: query.data.lifecycle,
        attention: query.data.attention,
      });

      return json({
        alerts: alerts.map((a) => ({ ...a, name: alertDisplayName(a) })),
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to list monitoring alerts", {
        userId: authentication.userId,
        error,
      });
      throw error;
    }
  }
);

export const action = createMonitoringAlertsAction();
