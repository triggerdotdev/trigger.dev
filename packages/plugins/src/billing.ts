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

export type ProvisionFreePlanContractParams = {
  organizationId: string;
  signal?: AbortSignal;
};

export type ProvisionFreePlanContractResult = {
  organizationId: string;
  billingCustomerId: string;
  contractId: string;
  outcome: "created" | "already_provisioned";
};

export type BillingUsageError =
  | "feature_disabled"
  | "not_configured"
  | "customer_not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "internal";

export type BillingCurrency = {
  code: string;
  minorUnitsPerUnit: 100 | 1;
};

export type BillingCreditType = {
  id: string;
  name: string;
  currency: BillingCurrency | null;
};

export type BillingUsageMetric = "compute" | "runs";

export type BillingUsageUnit = "millisecond" | "run";

export type BillingInvoiceLineItem = {
  name: string;
  type: string;
  productId: string | null;
  commitId?: string | null;
  metric?: BillingUsageMetric | null;
  unit?: BillingUsageUnit | null;
  quantity: number | null;
  unitPrice: number | null;
  total: number;
  creditType: BillingCreditType;
  startsAt: string | null;
  endsAt: string | null;
  pricingGroupValues: Record<string, string>;
  presentationGroupValues: Record<string, string>;
};

export type BillingUsageWindow = {
  startsAt: string;
  endsAt: string;
  invoiceId: string;
  total: number;
  creditType: BillingCreditType;
  lineItems: BillingInvoiceLineItem[];
};

export type BillingUsageMonthParams = {
  organizationId: string;
  month: string;
};

export type BillingUsageDay = {
  date: string;
  total: number;
};

export type BillingMonthlyUsageLine = {
  usageType: BillingUsageMetric;
  machinePreset: string | null;
  region: string | null;
  environmentType: string | null;
  quantity: number;
  unitPrice: number | null;
  total: number;
};

export type BillingUsageCredit = {
  id: string;
  name: string;
  kind: "credit" | "commit";
  included?: boolean;
  amount: number;
  applied: number;
  startsAt: string;
  endsAt: string | null;
};

export type BillingMonthlyUsage = {
  organizationId: string;
  fetchedAt: string;
  month: string;
  isCurrentMonth: boolean;
  availableFrom: string | null;
  creditType: BillingCreditType | null;
  total: number;
  creditsApplied: number;
  creditsGranted?: number;
  /** Credit that offsets usage: grants restricted to usage products, plus what other credits applied to usage. */
  creditsForUsage?: number;
  credits?: BillingUsageCredit[];
  days: BillingUsageDay[];
  lines: BillingMonthlyUsageLine[];
};

export type BillingProjectUsageDayEntry = {
  projectId: string;
  computeMs: number;
  runs: number;
};

export type BillingProjectUsageDay = {
  date: string;
  projects: BillingProjectUsageDayEntry[];
};

export type BillingProjectUsageLine = {
  projectId: string;
  machinePreset: string | null;
  region: string | null;
  environmentType: string | null;
  computeMs: number;
  runs: number;
};

export type BillingProjectUsage = {
  organizationId: string;
  fetchedAt: string;
  month: string;
  isCurrentMonth: boolean;
  truncated: boolean;
  projectIds: string[];
  days: BillingProjectUsageDay[];
  lines: BillingProjectUsageLine[];
};

export interface BillingController {
  isUsingPlugin(): Promise<boolean>;

  getCustomer(organizationId: string): ResultAsync<BillingCustomer | null, BillingCustomerError>;

  provisionCustomer(
    params: ProvisionBillingCustomerParams
  ): ResultAsync<ProvisionBillingCustomerResult, BillingCustomerError>;

  provisionFreePlanContract(
    params: ProvisionFreePlanContractParams
  ): ResultAsync<ProvisionFreePlanContractResult, BillingCustomerError>;

  getMonthlyUsage(
    params: BillingUsageMonthParams
  ): ResultAsync<BillingMonthlyUsage, BillingUsageError>;

  getProjectUsage(
    params: BillingUsageMonthParams
  ): ResultAsync<BillingProjectUsage, BillingUsageError>;

  /** Drops the org's cached usage for the current month, e.g. after a plan change. Never fails. */
  clearCurrentMonthUsage(organizationId: string): ResultAsync<void, never>;
}

export type BillingPluginConfig = {
  database?: PluginDatabaseConfig;
};

export interface BillingPlugin {
  create(config?: BillingPluginConfig): BillingController | Promise<BillingController>;
}
