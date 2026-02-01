import { BasePresenter } from "./basePresenter.server";
import type { QueryScope } from "~/services/queryService.server";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { builtInDashboard } from "./BuiltInDashboards.server";
import { QueryWidgetConfig } from "~/components/metrics/QueryWidget";

export type MetricFilters = {
  /** Org, project, environment */
  scope: QueryScope;
  /** Time filter settings */
  filterPeriod: string | null;
  filterFrom: Date | null;
  filterTo: Date | null;
  /** Tasks */
  taskIdentifiers?: string[];
  /** Queues */
  queues?: string[];
  /** Tags */
  tags?: string[];
};

const LayoutItem = z.object({
  i: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const Widget = z.object({
  title: z.string(),
  query: z.string(),
  display: QueryWidgetConfig,
});

const DashboardLayout = z.discriminatedUnion("version", [
  z.object({
    version: z.literal("1"),
    layout: z.array(LayoutItem),
    widgets: z.record(Widget),
  }),
]);

export type DashboardLayout = z.infer<typeof DashboardLayout>;

export type CustomDashboard = {
  id: string;
  title: string;
  layout: DashboardLayout;
};

export type BuiltInDashboard = {
  key: string;
  title: string;
  layout: DashboardLayout;
};

/** Returns the dashboard layout */
export class MetricDashboardPresenter extends BasePresenter {
  public async customDashboard({
    dashboardId,
    organizationId,
  }: {
    dashboardId: string;
    organizationId: string;
  }): Promise<CustomDashboard> {
    const dashboard = await this._replica.metricsDashboard.findFirst({
      where: { id: dashboardId, organizationId },
    });
    if (!dashboard) {
      throw new Error("No dashboard found");
    }

    const layout = this.#getLayout(dashboard.layout);

    return {
      id: dashboardId,
      title: dashboard.title,
      layout,
    };
  }

  public async builtInDashboard(key: string): Promise<BuiltInDashboard> {
    return builtInDashboard(key);
  }

  #getLayout(layoutData: string): DashboardLayout {
    const parsedLayout = DashboardLayout.safeParse(layoutData);
    if (!parsedLayout.success) {
      throw fromZodError(parsedLayout.error);
    }

    return parsedLayout.data;
  }
}
