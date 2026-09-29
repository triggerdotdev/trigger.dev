import type { ResultAsync } from "neverthrow";
import type { PluginDatabaseConfig } from "./databaseConfig.js";

export type BillingCustomerError =
  | "feature_disabled"
  | "not_configured"
  | "organization_not_found"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "internal";

export type BillingCustomer = {
  organizationId: string;
  billingCustomerId: string;
};

export type ProvisionBillingCustomerOutcome = "created" | "already_provisioned" | "in_progress";

export type ProvisionBillingCustomerResult = {
  organizationId: string;
  billingCustomerId: string | null;
  outcome: ProvisionBillingCustomerOutcome;
};

export type ProvisionBillingCustomerParams = {
  organizationId: string;
  name?: string;
  signal?: AbortSignal;
};

export interface BillingController {
  isUsingPlugin(): Promise<boolean>;

  getCustomer(organizationId: string): ResultAsync<BillingCustomer | null, BillingCustomerError>;

  provisionCustomer(
    params: ProvisionBillingCustomerParams
  ): ResultAsync<ProvisionBillingCustomerResult, BillingCustomerError>;
}

export type BillingPluginConfig = {
  database?: PluginDatabaseConfig;
};

export interface BillingPlugin {
  create(config?: BillingPluginConfig): BillingController | Promise<BillingController>;
}
