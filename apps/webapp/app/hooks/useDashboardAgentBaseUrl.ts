import { useTypedRouteLoaderData } from "remix-typedjson";
import type { loader } from "../root";

export function useDashboardAgentBaseUrl() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return routeMatch!.dashboardAgentBaseUrl;
}
