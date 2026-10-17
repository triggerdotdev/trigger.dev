import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import {
  CreateDashboardRequestBody,
  type DashboardSummary,
  type DashboardWidgetSummary,
} from "@trigger.dev/core/v3/schemas";
import type { BuiltInDashboard } from "~/presenters/v3/MetricDashboardPresenter.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { builtInDashboard } from "~/presenters/v3/BuiltInDashboards.server";
import {
  assertValidWidgetQueries,
  dashboardApiErrorResponse,
  MetricDashboardService,
  toDashboardObject,
  toDashboardSummary,
} from "~/v3/services/metricDashboard.server";

const BUILT_IN_DASHBOARD_KEYS = ["overview", "llm"];

function serializeDashboard(dashboard: BuiltInDashboard): DashboardSummary {
  const widgets: DashboardWidgetSummary[] = [];

  if (dashboard.layout.version === "1") {
    for (const [id, widget] of Object.entries(dashboard.layout.widgets)) {
      // Skip title widgets — they're just section headers
      if (widget.display.type === "title") continue;

      widgets.push({
        id,
        title: widget.title,
        query: widget.query,
        type: widget.display.type,
      });
    }
  }

  return {
    key: dashboard.key,
    title: dashboard.title,
    type: "builtIn",
    widgets,
  };
}

export const loader = createLoaderApiRoute(
  {
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: () => ({ type: "query", id: "dashboards" }),
    },
  },
  async ({ authentication }) => {
    const builtIn = BUILT_IN_DASHBOARD_KEYS.map((key) => {
      try {
        return serializeDashboard(builtInDashboard(key));
      } catch {
        return null;
      }
    }).filter((d): d is DashboardSummary => d !== null);

    const custom = await new MetricDashboardService().list(
      authentication.environment.organizationId
    );

    return json({ dashboards: [...builtIn, ...custom.map(toDashboardSummary)] });
  }
);

const { action } = createActionApiRoute(
  {
    method: "POST",
    allowJWT: true,
    body: CreateDashboardRequestBody,
    authorization: {
      action: "write",
      resource: () => ({ type: "query", id: "dashboards" }),
    },
  },
  async ({ body, authentication }) => {
    const [error, dashboard] = await tryCatch(
      (async () => {
        if (body.widgets) {
          assertValidWidgetQueries(body.widgets);
        }

        return new MetricDashboardService().create({
          organizationId: authentication.environment.organizationId,
          projectId: authentication.environment.projectId,
          ownerId: authentication.actor?.sub ?? null,
          title: body.title,
          description: body.description,
          widgets: body.widgets,
        });
      })()
    );

    if (error) {
      return dashboardApiErrorResponse(error);
    }

    return json(toDashboardObject(dashboard), { status: 201 });
  }
);

export { action };
