import { BillingClient } from "@trigger.dev/billing";

export class BillingPresenter {
  #billingClient: BillingClient | undefined;

  constructor(isManagedCloud: boolean) {
    if (isManagedCloud && process.env.BILLING_API_URL && process.env.BILLING_API_KEY) {
      this.#billingClient = new BillingClient({
        url: process.env.BILLING_API_URL,
        apiKey: process.env.BILLING_API_KEY,
      });
    }
  }

  async currentPlan(orgId: string) {
    if (!this.#billingClient) return undefined;
    return this.#billingClient.currentPlan(orgId);
  }
}
