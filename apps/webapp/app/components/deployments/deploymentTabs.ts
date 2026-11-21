export const DEPLOYMENT_TABS = ["overview", "tasks", "runs", "logs", "activity"] as const;
export type DeploymentTab = (typeof DEPLOYMENT_TABS)[number];

/**
 * The deployment page's tabs; the first is the one the page opens on. Build logs is only there
 * when the deploy has a log stream (a deploy built by the CLI has none). A deploy without a
 * worker (failed, canceled or still building) opens on its build logs, or on Activity, where the
 * error is, when it has none.
 */
export function deploymentTabs({
  hasWorker,
  hasLogs,
}: {
  hasWorker: boolean;
  hasLogs: boolean;
}): DeploymentTab[] {
  const tabs = DEPLOYMENT_TABS.filter((tab) => hasLogs || tab !== "logs");
  if (hasWorker) return tabs;
  const first: DeploymentTab = hasLogs ? "logs" : "activity";
  return [first, ...tabs.filter((tab) => tab !== first)];
}
