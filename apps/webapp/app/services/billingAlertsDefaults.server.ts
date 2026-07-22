import type { UpdateBillingAlertsRequest } from "@trigger.dev/platform";
import { ABSOLUTE_ALERT_BASE_CENTS } from "~/components/billing/billingAlertsFormat";

/** Default absolute alert thresholds in dollars. */
const DEFAULT_ALERT_THRESHOLD_DOLLARS = [5, 100, 500, 1000, 2500];

/**
 * Build the default billing alerts for an org that has none configured.
 *
 * The platform evaluates alerts as `usage / amount >= level`. Setting `amount`
 * to the $1 base (100 cents) turns `alertLevels` into absolute dollar thresholds,
 * which is what the current "no limit configured" UI expects.
 *
 * Emails are left empty: the platform falls back to org admin/member addresses
 * when no recipients are configured.
 */
export function buildDefaultBillingAlerts(): UpdateBillingAlertsRequest {
  return {
    amount: ABSOLUTE_ALERT_BASE_CENTS,
    emails: [],
    alertLevels: [...DEFAULT_ALERT_THRESHOLD_DOLLARS],
  };
}

/**
 * Whether alerts look never-configured. When no alert row exists the platform
 * returns a default of `{ amount: planIncludedUsage, emails: [], alertLevels: [] }`;
 * a deliberately cleared config stores the $1 absolute base amount and/or keeps
 * the configured emails.
 */
export function billingAlertsLookUnconfigured(alerts: {
  amount: number;
  emails: string[];
  alertLevels: number[];
}): boolean {
  return (
    alerts.alertLevels.length === 0 &&
    alerts.emails.length === 0 &&
    alerts.amount !== ABSOLUTE_ALERT_BASE_CENTS
  );
}
