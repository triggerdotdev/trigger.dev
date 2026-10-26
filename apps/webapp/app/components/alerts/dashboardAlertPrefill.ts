import type { AlertDraftPrefillParams } from "~/utils/pathBuilder";

const DASHBOARD_ALERT_PREFILL = new Map<string, AlertDraftPrefillParams>([
  ["overview", { capability: "health.all", scope: "all" }],
  ["queues", { capability: "queue.depth" }],
]);

export function dashboardAlertPrefill(key: string): AlertDraftPrefillParams | undefined {
  return DASHBOARD_ALERT_PREFILL.get(key);
}
