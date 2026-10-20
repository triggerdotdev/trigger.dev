/**
 * The single Alerts-list gating rule: the `alertsEnabled` flag (per-org override
 * winning), or the viewer being a platform admin. Off leaves the legacy channel-list
 * page unchanged for non-admins.
 */
export function computeCanUseAlertsList(flagEnabled: boolean, isAdmin: boolean): boolean {
  return flagEnabled || isAdmin;
}

export function isAlertsEnabledEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
