import type {
  BillingController,
  BillingCustomer,
  BillingCustomerError,
  ProvisionBillingCustomerResult,
} from "@trigger.dev/plugins";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

export class BillingFallback {
  create(): BillingController {
    return new BillingFallbackController();
  }
}

class BillingFallbackController implements BillingController {
  async isUsingPlugin(): Promise<boolean> {
    return false;
  }

  getCustomer(_organizationId: string): ResultAsync<BillingCustomer | null, BillingCustomerError> {
    return okAsync(null);
  }

  provisionCustomer(): ResultAsync<ProvisionBillingCustomerResult, BillingCustomerError> {
    return errAsync("feature_disabled");
  }
}
