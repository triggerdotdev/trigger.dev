// Every link into the dashboard goes through here.
const productionDashboardOrigin = "https://cloud.trigger.dev";

const dashboardOrigin = process.env.NEXT_PUBLIC_DASHBOARD_URL || productionDashboardOrigin;

export function dashboardLink(path = "/"): string {
  return new URL(path, dashboardOrigin).toString();
}
