import { type BuiltInDashboard } from "./MetricDashboardPresenter.server";

const overviewDashboard: BuiltInDashboard = {
  key: "overview",
  title: "Overview",
  layout: {
    version: "1",
    layout: [],
    widgets: {},
  },
};

const builtInDashboards: BuiltInDashboard[] = [overviewDashboard];

export function builtInDashboard(key: string): BuiltInDashboard {
  const dashboard = builtInDashboards.find((d) => d.key === key);
  if (!dashboard) {
    throw new Error(`No built-in dashboard "${key}"`);
  }

  return dashboard;
}
