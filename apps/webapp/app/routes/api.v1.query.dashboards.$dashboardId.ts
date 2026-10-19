import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import {
  ReplaceDashboardRequestBody,
  UpdateDashboardRequestBody,
} from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import {
  createLoaderApiRoute,
  createMultiMethodApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import {
  assertValidWidgetQueries,
  dashboardApiErrorResponse,
  MetricDashboardService,
  toDashboardObject,
} from "~/v3/services/metricDashboard.server";

const ParamsSchema = z.object({
  dashboardId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: () => ({ type: "query", id: "dashboards" }),
    },
  },
  async ({ params, authentication }) => {
    const [error, dashboard] = await tryCatch(
      new MetricDashboardService().get({
        organizationId: authentication.environment.organizationId,
        friendlyId: params.dashboardId,
      })
    );

    if (error) {
      return dashboardApiErrorResponse(error);
    }

    return json(toDashboardObject(dashboard));
  }
);

const { action } = createMultiMethodApiRoute({
  params: ParamsSchema,
  allowJWT: true,
  authorization: {
    action: "write",
    resource: () => ({ type: "query", id: "dashboards" }),
  },
  methods: {
    PATCH: {
      body: UpdateDashboardRequestBody,
      handler: async ({ params, body, authentication }) => {
        const input = body as z.infer<typeof UpdateDashboardRequestBody>;
        const [error, dashboard] = await tryCatch(
          new MetricDashboardService().update({
            organizationId: authentication.environment.organizationId,
            friendlyId: params.dashboardId,
            title: input.title,
            description: input.description,
            revision: input.revision,
          })
        );

        if (error) {
          return dashboardApiErrorResponse(error);
        }

        return json(toDashboardObject(dashboard));
      },
    },
    PUT: {
      body: ReplaceDashboardRequestBody,
      handler: async ({ params, body, authentication }) => {
        const input = body as z.infer<typeof ReplaceDashboardRequestBody>;
        const [error, dashboard] = await tryCatch(
          (async () => {
            assertValidWidgetQueries(input.widgets);

            return new MetricDashboardService().replace({
              organizationId: authentication.environment.organizationId,
              friendlyId: params.dashboardId,
              title: input.title,
              description: input.description,
              widgets: input.widgets,
              revision: input.revision,
            });
          })()
        );

        if (error) {
          return dashboardApiErrorResponse(error);
        }

        return json(toDashboardObject(dashboard));
      },
    },
    DELETE: {
      handler: async ({ params, authentication }) => {
        const [error, dashboard] = await tryCatch(
          new MetricDashboardService().delete({
            organizationId: authentication.environment.organizationId,
            friendlyId: params.dashboardId,
          })
        );

        if (error) {
          return dashboardApiErrorResponse(error);
        }

        return json({ id: dashboard.friendlyId });
      },
    },
  },
});

export { action };
