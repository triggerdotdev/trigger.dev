/**
 * The single Alerts-list gating rule: the `alertsEnabled` flag (per-org override
 * winning), or a platform admin on an install where alerts are configured. Off leaves
 * the legacy channel-list page unchanged.
 */
export function computeCanUseAlertsList(
  flagEnabled: boolean,
  isAdmin: boolean,
  alertsConfigured: boolean
): boolean {
  return flagEnabled || (isAdmin && alertsConfigured);
}

export function isAlertsEnabledEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
