import type {
  BillingController,
  BillingCustomer,
  BillingCustomerError,
  BillingMonthlyUsage,
  BillingProjectUsage,
  BillingUsageError,
  ProvisionBillingCustomerResult,
  ProvisionFreePlanContractResult,
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

  provisionFreePlanContract(): ResultAsync<ProvisionFreePlanContractResult, BillingCustomerError> {
    return errAsync("feature_disabled");
  }

  getMonthlyUsage(): ResultAsync<BillingMonthlyUsage, BillingUsageError> {
    return errAsync("feature_disabled");
  }

  getProjectUsage(): ResultAsync<BillingProjectUsage, BillingUsageError> {
    return errAsync("feature_disabled");
  }

  clearCurrentMonthUsage(): ResultAsync<void, never> {
    return okAsync(undefined);
  }
}
