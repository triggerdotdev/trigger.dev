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
