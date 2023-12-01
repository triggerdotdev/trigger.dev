import { BillingClient } from "@trigger.dev/billing";
import { logger } from "~/services/logger.server";

export class BillingPresenter {
  #billingClient: BillingClient | undefined;

  constructor(isManagedCloud: boolean) {
    if (isManagedCloud && process.env.BILLING_API_URL && process.env.BILLING_API_KEY) {
      this.#billingClient = new BillingClient({
        url: process.env.BILLING_API_URL,
        apiKey: process.env.BILLING_API_KEY,
      });
      console.log(`Billing client initialized: ${process.env.BILLING_API_URL}`);
    } else {
      console.log(`Billing client not initialized`);
    }
  }

  async currentPlan(orgId: string) {
    if (!this.#billingClient) return undefined;
    try {
      return this.#billingClient.currentPlan(orgId);
    } catch (e) {
      logger.error("Error getting current plan", { orgId, error: e });
      return undefined;
    }
  }
}
