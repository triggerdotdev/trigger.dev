import type {
  BillingCreditType,
  BillingUsageCredit,
  BillingUsageCreditSource,
  BillingUsageError,
} from "@trigger.dev/billing";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { UsageDimension, UsageType } from "./billingUsageBreakdown";
import { formatCurrency } from "./numberFormatter";

export type BillingUsageErrorState = {
  kind: "empty" | "retry" | "error";
  title: string;
  message: string;
};

export const USD_CENTS_CREDIT_TYPE: BillingCreditType = {
  id: "usd-cents",
  name: "USD (cents)",
  currency: { code: "USD", minorUnitsPerUnit: 100 },
};

const quantityFormatter = Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

export function formatCreditAmount(amount: number, creditType: BillingCreditType): string {
  if (!creditType.currency) {
    return `${quantityFormatter.format(amount)} ${creditType.name}`;
  }

  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: creditType.currency.code,
    maximumFractionDigits: 4,
  }).format(amount / creditType.currency.minorUnitsPerUnit);
}

const ERROR_STATES: Record<BillingUsageError, BillingUsageErrorState> = {
  feature_disabled: {
    kind: "empty",
    title: "Usage billing isn't available",
    message: "Usage breakdowns aren't available for this organization.",
  },
  not_configured: {
    kind: "empty",
    title: "Usage billing isn't available",
    message: "Usage breakdowns aren't available for this organization.",
  },
  customer_not_found: {
    kind: "empty",
    title: "No usage yet",
    message: "This organization doesn't have any usage billing history yet.",
  },
  rate_limited: {
    kind: "retry",
    title: "Too many requests",
    message: "We couldn't load your billing data right now. Try again shortly.",
  },
  upstream_unavailable: {
    kind: "retry",
    title: "Billing data is temporarily unavailable",
    message: "We couldn't reach our billing provider. Try again shortly.",
  },
  upstream_rejected: {
    kind: "error",
    title: "Couldn't load billing data",
    message: "Something went wrong loading your billing data. Contact us if this keeps happening.",
  },
  internal: {
    kind: "error",
    title: "Couldn't load billing data",
    message: "Something went wrong loading your billing data. Contact us if this keeps happening.",
  },
};

export function billingUsageErrorState(error: BillingUsageError): BillingUsageErrorState {
  return ERROR_STATES[error];
}

export type ComputeTimeFormat = "ms" | "readable";

const DURATION_UNITS: [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
  ["ms", 1],
];

const integerFormatter = Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatReadableDuration(milliseconds: number): string {
  let rest = Math.round(milliseconds);
  if (rest <= 0) return "0ms";

  const parts: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) parts.push(`${integerFormatter.format(count)}${unit}`);
  }
  return parts.join(" ");
}

export function formatComputeTime(milliseconds: number, format: ComputeTimeFormat): string {
  if (format === "readable") return formatReadableDuration(milliseconds);
  return `${integerFormatter.format(milliseconds)} ms`;
}

export function formatDurationTick(milliseconds: number): string {
  if (milliseconds <= 0) return "0";
  if (milliseconds >= 3_600_000) return `${integerFormatter.format(milliseconds / 3_600_000)}h`;
  if (milliseconds >= 60_000) return `${integerFormatter.format(milliseconds / 60_000)}m`;
  if (milliseconds >= 1_000) return `${integerFormatter.format(milliseconds / 1_000)}s`;
  return `${integerFormatter.format(milliseconds)}ms`;
}

export function formatUsageQuantity(usageType: UsageType, quantity: number): string {
  if (usageType === "runs") return `${integerFormatter.format(quantity)} runs`;
  if (quantity > 0 && quantity < 60_000) return formatReadableDuration(quantity);

  const minutes = Math.round(quantity / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes % 60}m`;
  return `${integerFormatter.format(hours)}h ${minutes % 60}m`;
}

function formatRateAmount(amount: number, creditType: BillingCreditType): string {
  if (!creditType.currency) return formatCreditAmount(amount, creditType);

  const major = amount / creditType.currency.minorUnitsPerUnit;
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: creditType.currency.code,
    ...(major < 0.01 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 4 }),
  }).format(major);
}

export function formatUnitPrice(
  usageType: UsageType,
  unitPrice: number,
  creditType: BillingCreditType
): string {
  if (usageType === "runs") {
    return `${formatRateAmount(unitPrice * 10_000, creditType)} / 10k runs`;
  }
  return `${formatRateAmount(unitPrice * 1_000, creditType)} / sec`;
}

const USAGE_DIMENSION_TITLES: Record<UsageDimension, string> = {
  project: "Project",
  usageType: "Usage type",
  machine: "Machine",
  environment: "Environment",
  region: "Region",
};

export function usageDimensionTitle(dimension: UsageDimension): string {
  return USAGE_DIMENSION_TITLES[dimension];
}

const USAGE_TYPE_LABELS: Record<UsageType, string> = {
  compute: "Compute time",
  runs: "Runs",
};

export function usageTypeLabel(usageType: string): string {
  return USAGE_TYPE_LABELS[usageType as UsageType] ?? usageType;
}

const ENVIRONMENT_TYPES: Record<string, RuntimeEnvironmentType> = {
  production: "PRODUCTION",
  staging: "STAGING",
  preview: "PREVIEW",
  development: "DEVELOPMENT",
};

export function usageEnvironmentType(value: string): RuntimeEnvironmentType | undefined {
  return ENVIRONMENT_TYPES[value];
}

export function usageRegionLocation(region: string): "usa" | "europe" | undefined {
  if (region.startsWith("us-")) return "usa";
  if (region.startsWith("eu-")) return "europe";
  return undefined;
}

export function sharePercent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

const SMALLEST_SHOWN_DOLLARS = 0.01;

export function formatUsageDollars(dollars: number): string {
  if (dollars > 0 && dollars < SMALLEST_SHOWN_DOLLARS) return "<$0.01";
  return formatCurrency(dollars, false);
}

const CREDIT_SOURCE_LABELS: Record<BillingUsageCreditSource, string> = {
  plan: "Plan credit",
  contract: "Contract credit",
  proration: "Unused time credit",
  goodwill: "Granted credit",
};

export function creditSourceLabel(credit: Pick<BillingUsageCredit, "source" | "kind">): string {
  if (credit.source) return CREDIT_SOURCE_LABELS[credit.source];
  return credit.kind === "commit" ? "Commit" : "Credit";
}

// Metronome names some credits after the plan's code, e.g. "Unused v3_hobby_1 fee".
const PLAN_CODE = /\bv\d+_([a-z]+)_\d+\b/g;

export function billingDisplayName(name: string): string {
  return name.replace(PLAN_CODE, (_, tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1));
}

// Pack sizes of the self-serve add-ons, keyed by the start of their Metronome product name.
const ADD_ON_PACKS: { product: string; size: number; unit: [string, string] }[] = [
  { product: "Additional Concurrency", size: 50, unit: ["concurrent run", "concurrent runs"] },
  { product: "Additional Schedules", size: 1000, unit: ["schedule", "schedules"] },
  { product: "Additional Seats", size: 1, unit: ["seat", "seats"] },
  { product: "Additional Preview Branches", size: 1, unit: ["preview branch", "preview branches"] },
];

/** "100 concurrent runs (2 × 50)" for an add-on sold in packs; the bare quantity when the add-on is unknown. */
export function formatAddOnQuantity(name: string, quantity: number): string {
  const pack = ADD_ON_PACKS.find((entry) => name.startsWith(entry.product));
  if (!pack) return quantityFormatter.format(quantity);

  const amount = quantity * pack.size;
  const unit = amount === 1 ? pack.unit[0] : pack.unit[1];
  const total = `${integerFormatter.format(amount)} ${unit}`;
  return pack.size === 1
    ? total
    : `${total} (${quantityFormatter.format(quantity)} × ${integerFormatter.format(pack.size)})`;
}
