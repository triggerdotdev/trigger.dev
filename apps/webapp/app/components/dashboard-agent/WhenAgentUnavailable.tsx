import { useDashboardAgent } from "./dashboardAgentLauncher";

export function WhenAgentUnavailable({ children }: { children: React.ReactNode }) {
  const agent = useDashboardAgent();
  if (agent) {
    return null;
  }

  return children;
}
