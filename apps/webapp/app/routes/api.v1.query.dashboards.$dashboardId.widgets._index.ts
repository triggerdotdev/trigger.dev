import { json } from "@remix-run/server-runtime";
import { assertDashboardApiAccess } from "~/services/metricDashboardApiAccess.server";
import { tryCatch } from "@trigger.dev/core/utils";
import { AddDashboardWidgetRequestBody } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import {
  assertValidWidgetQueries,
  dashboardApiErrorResponse,
  MetricDashboardService,
  toDashboardObject,
} from "~/v3/services/metricDashboard.server";

const ParamsSchema = z.object({
  dashboardId: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    allowJWT: true,
    body: AddDashboardWidgetRequestBody,
    authorization: {
      action: "write",
      resource: () => ({ type: "query", id: "dashboards" }),
    },
  },
  async ({ params, body, authentication }) => {
    await assertDashboardApiAccess(authentication);
    const { revision, ...widget } = body;

    const [error, result] = await tryCatch(
      (async () => {
        assertValidWidgetQueries([widget]);

        return new MetricDashboardService().addWidget({
          organizationId: authentication.environment.organizationId,
          friendlyId: params.dashboardId,
          widget,
          revision,
        });
      })()
    );

    if (error) {
      return dashboardApiErrorResponse(error);
    }

    return json(
      { widgetId: result.widgetId, dashboard: toDashboardObject(result.dashboard) },
      { status: 201 }
    );
  }
);

export { action };
