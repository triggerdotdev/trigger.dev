import { json } from "@remix-run/server-runtime";
import { assertDashboardApiAccess } from "~/services/metricDashboardApiAccess.server";
import { tryCatch } from "@trigger.dev/core/utils";
import { UpdateDashboardWidgetRequestBody } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { createMultiMethodApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import {
  assertValidWidgetQueries,
  dashboardApiErrorResponse,
  MetricDashboardService,
  toDashboardObject,
} from "~/v3/services/metricDashboard.server";

const ParamsSchema = z.object({
  dashboardId: z.string(),
  widgetId: z.string(),
});

const SearchParamsSchema = z.object({
  revision: z.string().optional(),
});

const { action } = createMultiMethodApiRoute({
  params: ParamsSchema,
  searchParams: SearchParamsSchema,
  allowJWT: true,
  authorization: {
    action: "write",
    resource: () => ({ type: "query", id: "dashboards" }),
  },
  methods: {
    PATCH: {
      body: UpdateDashboardWidgetRequestBody,
      handler: async ({ params, body, authentication }) => {
        await assertDashboardApiAccess(authentication);
        const { revision, ...changes } = body as z.infer<typeof UpdateDashboardWidgetRequestBody>;
        const service = new MetricDashboardService();
        const ref = {
          organizationId: authentication.environment.organizationId,
          friendlyId: params.dashboardId,
        };

        const [error, dashboard] = await tryCatch(
          (async () => {
            if (changes.query !== undefined || changes.display !== undefined) {
              const current = await service.get(ref);
              const existing = toDashboardObject(current).widgets.find(
                (widget) => widget.id === params.widgetId
              );
              if (existing) {
                assertValidWidgetQueries([
                  {
                    id: params.widgetId,
                    title: changes.title ?? existing.title,
                    query: changes.query ?? existing.query,
                    display: changes.display ?? existing.display,
                  },
                ]);
              }
            }

            return service.updateWidget({
              ...ref,
              widgetId: params.widgetId,
              changes,
              revision,
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
      handler: async ({ params, searchParams, authentication }) => {
        await assertDashboardApiAccess(authentication);
        const [error, result] = await tryCatch(
          new MetricDashboardService().deleteWidget({
            organizationId: authentication.environment.organizationId,
            friendlyId: params.dashboardId,
            widgetId: params.widgetId,
            revision: searchParams.revision,
            requireExisting: true,
          })
        );

        if (error) {
          return dashboardApiErrorResponse(error);
        }

        return json(toDashboardObject(result.dashboard));
      },
    },
  },
});

export { action };
