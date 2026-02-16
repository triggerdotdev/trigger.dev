import { BasePresenter } from "./basePresenter.server";
import { type QueryScope } from "~/services/queryService.server";
import { getLimit } from "~/services/platform.v3.server";
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

export const LayoutItem = z.object({
  i: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  minH: z.number().optional(),
  maxH: z.number().optional(),
});

export type LayoutItem = z.infer<typeof LayoutItem>;

export const Widget = z.object({
  title: z.string(),
  query: z.string().default(""),
  display: QueryWidgetConfig,
});

export type Widget = z.infer<typeof Widget>;

export const DashboardLayout = z.discriminatedUnion("version", [
  z.object({
    version: z.literal("1"),
    layout: z.array(LayoutItem),
    widgets: z.record(Widget),
  }),
]);

export type DashboardLayout = z.infer<typeof DashboardLayout>;

export type CustomDashboard = {
  friendlyId: string;
  title: string;
  layout: DashboardLayout;
  defaultPeriod: string;
};

export type BuiltInDashboard = {
  key: string;
  title: string;
  layout: DashboardLayout;
};

/** Returns the dashboard layout */
export class MetricDashboardPresenter extends BasePresenter {
  public async customDashboard({
    friendlyId,
    organizationId,
  }: {
    friendlyId: string;
    organizationId: string;
  }): Promise<CustomDashboard> {
    const dashboard = await this._replica.metricsDashboard.findFirst({
      where: { friendlyId, organizationId },
    });
    if (!dashboard) {
      throw new Error("No dashboard found");
    }

    const layout = this.#getLayout(dashboard.layout);

    const defaultPeriod = await getDashboardDefaultPeriod(organizationId);

    return {
      friendlyId: dashboard.friendlyId,
      title: dashboard.title,
      layout,
      defaultPeriod,
    };
  }

  public async builtInDashboard({ organizationId, key }: { organizationId: string; key: string }) {
    const defaultPeriod = await getDashboardDefaultPeriod(organizationId);
    const dashboard = builtInDashboard(key);
    return {
      ...dashboard,
      defaultPeriod,
    };
  }

  #getLayout(layoutData: string): DashboardLayout {
    const json = JSON.parse(layoutData);
    const parsedLayout = DashboardLayout.safeParse(json);
    if (!parsedLayout.success) {
      throw fromZodError(parsedLayout.error);
    }

    return parsedLayout.data;
  }
}

/** Dashboard-specific default period (1 day), capped to the org's max query period */
async function getDashboardDefaultPeriod(organizationId: string): Promise<string> {
  const idealDefaultPeriodDays = 1;
  const maxQueryPeriod = await getLimit(organizationId, "queryPeriodDays", 30);
  if (maxQueryPeriod < idealDefaultPeriodDays) {
    return `${maxQueryPeriod}d`;
  }
  return `${idealDefaultPeriodDays}d`;
}
