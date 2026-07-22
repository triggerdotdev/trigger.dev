import type { UpdateBillingAlertsRequest } from "@trigger.dev/platform";
import { ABSOLUTE_ALERT_BASE_CENTS } from "~/components/billing/billingAlertsFormat";

/** Default absolute alert thresholds in dollars. */
const DEFAULT_ALERT_THRESHOLD_DOLLARS = [5, 100, 500, 1000, 2500];

/**
 * Alerts fire at `usage / amount >= level`; amount = 100 cents makes levels
 * absolute dollar thresholds. Empty emails fall back to org admins.
 */
export function buildDefaultBillingAlerts(): UpdateBillingAlertsRequest {
  return {
    amount: ABSOLUTE_ALERT_BASE_CENTS,
    emails: [],
    alertLevels: [...DEFAULT_ALERT_THRESHOLD_DOLLARS],
  };
}
