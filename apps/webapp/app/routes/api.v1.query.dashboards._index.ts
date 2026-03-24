import { json } from "@remix-run/server-runtime";
import type { DashboardSummary, DashboardWidgetSummary } from "@trigger.dev/core/v3/schemas";
import type { BuiltInDashboard } from "~/presenters/v3/MetricDashboardPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { builtInDashboard } from "~/presenters/v3/BuiltInDashboards.server";

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
      resource: () => ({ query: "dashboards" }),
      superScopes: ["read:query", "read:all", "admin"],
    },
  },
  async () => {
    const dashboards = BUILT_IN_DASHBOARD_KEYS.map((key) => {
      try {
        return serializeDashboard(builtInDashboard(key));
      } catch {
        return null;
      }
    }).filter((d): d is DashboardSummary => d !== null);
    return json({ dashboards });
  }
);
