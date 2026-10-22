import { json } from "@remix-run/server-runtime";
import { listCapabilities } from "@internal/alert-contracts";
import { offeredCapabilities } from "~/v3/services/alerts/offeredCapabilities.server";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import {
  alertsInAnyEnvironment,
  canUseMonitoringAlerts,
  findMonitoringAlertsProject,
  monitoringAlertsRouteContext,
} from "~/services/monitoringAlertsApi.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

const QuerySchema = z.object({
  area: z.string().optional(),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
    context: monitoringAlertsRouteContext,
    authorization: { action: "read", resource: alertsInAnyEnvironment },
  },
  async ({ request, params, authentication }) => {
    const query = QuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!query.success) {
      return json({ error: "Invalid query" }, { status: 400 });
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

      const capabilities = offeredCapabilities(
        listCapabilities({ area: query.data.area, surface: "mcp" })
      );

      return json({ capabilities });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to list monitoring alert capabilities", {
        userId: authentication.userId,
        error,
      });
      throw error;
    }
  }
);
