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
  /** Fetch and store the next chunk of settled days that aren't stored yet. */
  loadPending?: boolean;
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

/** plan: the plan's recurring credit; contract: another credit on a contract; proration: unused time
 * credited back after a plan or add-on change; goodwill: granted by hand. */
export type BillingUsageCreditSource = "plan" | "contract" | "proration" | "goodwill";

export type BillingUsageCredit = {
  id: string;
  name: string;
  kind: "credit" | "commit";
  source?: BillingUsageCreditSource;
  included?: boolean;
  /** Granted this month. */
  amount: number;
  /** Applied to usage this month. */
  applied: number;
  /** What this credit provides for usage this month: the whole grant for a usage-only credit, else what it applied. */
  forUsage?: number;
  startsAt: string;
  endsAt: string | null;
};

export type BillingMonthlyUsage = {
  organizationId: string;
  fetchedAt: string;
  month: string;
  isCurrentMonth: boolean;
  creditType: BillingCreditType | null;
  total: number;
  creditsApplied: number;
  creditsGranted?: number;
  /** Credit provided for usage this month: the sum of each credit's `forUsage`. */
  creditsForUsage?: number;
  credits?: BillingUsageCredit[];
  days: BillingUsageDay[];
  lines: BillingMonthlyUsageLine[];
  /** Settled days not stored yet, so missing from the totals. */
  pendingDays?: number;
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
  pendingDays?: number;
};

export type BillingAddOnLine = {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
  total: number;
};

export type BillingAddOnCharge = {
  name: string;
  date: string;
  total: number;
};

export type BillingAddOns = {
  organizationId: string;
  fetchedAt: string;
  month: string;
  creditType: BillingCreditType | null;
  /** The 1st of the following month, when `next` is invoiced. */
  invoiceDate: string;
  next: BillingAddOnLine[];
  /** Add-on charges and credits invoiced during the month, prorated charges included. */
  charged: BillingAddOnCharge[];
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

  getAddOns(params: BillingUsageMonthParams): ResultAsync<BillingAddOns, BillingUsageError>;

  /** Drops the org's cached usage for the current month, e.g. after a plan change. Never fails. */
  clearCurrentMonthUsage(organizationId: string): ResultAsync<void, never>;

  /** Drops the org's stored and cached usage from `from` onwards, e.g. after a change that reprices it. */
  forgetUsageFrom(organizationId: string, from: Date): ResultAsync<void, never>;
}

export type BillingPluginConfig = {
  database?: PluginDatabaseConfig;
};

export interface BillingPlugin {
  create(config?: BillingPluginConfig): BillingController | Promise<BillingController>;
}
