import type { BillingLimitResult } from "~/services/billingLimit.schemas";

export type BillingAlertsFormData = {
  /** Stored base amount in dollars (from API cents / 100). Used when converting legacy alerts. */
  amount: number;
  emails: string[];
  alertLevels: number[];
};

/** $1 base (in cents) for absolute spend alerts when billing limit mode is none. */
export const ABSOLUTE_ALERT_BASE_CENTS = 100;

export const MAX_PERCENTAGE_ALERTS = 5;
export const MAX_ABSOLUTE_ALERTS = 10;
export const MAX_PERCENTAGE_THRESHOLD = 100;

export type BillingLimitMode = "plan" | "custom" | "none";

export function getBillingLimitMode(billingLimit: BillingLimitResult): BillingLimitMode {
  if (!billingLimit.isConfigured) {
    return "none";
  }
  return billingLimit.mode;
}

export function isPercentageAlertMode(mode: BillingLimitMode): boolean {
  return mode === "plan" || mode === "custom";
}

export function shouldClearAlertsOnLimitChange(
  previousMode: BillingLimitMode,
  nextMode: BillingLimitMode
): boolean {
  return shouldResetAlertsOnLimitChange(previousMode, nextMode);
}

/** Alert format changes when crossing between percentage (plan/custom) and dollar (none) modes. */
export function shouldResetAlertsOnLimitChange(
  previousMode: BillingLimitMode | null,
  nextMode: BillingLimitMode
): boolean {
  if (previousMode === null) {
    return false;
  }

  return isPercentageAlertMode(previousMode) !== isPercentageAlertMode(nextMode);
}

/** Configured billing limit mode before a save; null when billing limit was never configured. */
export function getPreviousBillingLimitModeForAlertSync(
  billingLimit: BillingLimitResult
): BillingLimitMode | null {
  if (!billingLimit.isConfigured) {
    return null;
  }

  return billingLimit.mode;
}

export function hasConfiguredAlerts(
  alerts: BillingAlertsFormData,
  billingLimit: BillingLimitResult,
  planLimitCents: number
): boolean {
  const mode = getBillingLimitMode(billingLimit);
  const effectiveLimitCents = getEffectiveLimitCents(billingLimit, planLimitCents);
  return storedAlertsToThresholds(alerts, mode, effectiveLimitCents, planLimitCents).length > 0;
}

export function hasSavedAlertThresholds(alerts: BillingAlertsFormData): boolean {
  return alerts.alertLevels.length > 0;
}

/** Saved thresholds that would be cleared when the billing limit alert format changes. */
export function hadSavedAlertsToClearOnLimitChange(
  alerts: BillingAlertsFormData,
  billingLimit: BillingLimitResult,
  planLimitCents: number
): boolean {
  return hasConfiguredAlerts(alerts, billingLimit, planLimitCents);
}

export function normalizeThresholdValues(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function thresholdValuesAreUnique(values: number[]): boolean {
  const normalized = normalizeThresholdValues(values);
  return new Set(normalized).size === normalized.length;
}

export function normalizeEmailValues(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function thresholdsMatchSaved(current: number[], saved: number[]): boolean {
  return (
    JSON.stringify(normalizeThresholdValues(current)) ===
    JSON.stringify(normalizeThresholdValues(saved))
  );
}

export function emailsMatchSaved(current: string[], saved: string[]): boolean {
  return (
    JSON.stringify(normalizeEmailValues(current)) === JSON.stringify(normalizeEmailValues(saved))
  );
}

export function clearedAlertsPayload(emails: string[] = []): {
  amount: number;
  alertLevels: number[];
  emails: string[];
} {
  return {
    amount: ABSOLUTE_ALERT_BASE_CENTS,
    alertLevels: [],
    emails,
  };
}

export function resetAlertsPayloadForLimitMode(
  nextMode: BillingLimitMode,
  effectiveLimitCents: number,
  emails: string[] = []
): { amount: number; alertLevels: number[]; emails: string[] } {
  if (nextMode === "none") {
    return clearedAlertsPayload(emails);
  }

  return {
    amount: effectiveLimitCents,
    alertLevels: [],
    emails,
  };
}

export function getEffectiveLimitCents(
  billingLimit: BillingLimitResult,
  planLimitCents: number
): number {
  if (!billingLimit.isConfigured) {
    return planLimitCents;
  }
  if (billingLimit.mode === "custom") {
    return billingLimit.amountCents;
  }
  if (billingLimit.mode === "plan") {
    return billingLimit.effectiveAmountCents ?? planLimitCents;
  }
  return planLimitCents;
}

/** Billing limit in cents when configured (plan/custom); undefined for none or unconfigured. */
export function getConfiguredBillingLimitCents(
  billingLimit: BillingLimitResult | undefined,
  planLimitCents: number
): number | undefined {
  if (!billingLimit?.isConfigured || billingLimit.mode === "none") {
    return undefined;
  }
  return getEffectiveLimitCents(billingLimit, planLimitCents);
}

/** Dollars for UsageBar marker; omitted when no limit or same as plan included usage. */
export function getUsageBarBillingLimitDollars(
  billingLimit: BillingLimitResult | undefined,
  planLimitCents: number
): number | undefined {
  const limitCents = getConfiguredBillingLimitCents(billingLimit, planLimitCents);
  if (limitCents === undefined || limitCents === planLimitCents) {
    return undefined;
  }
  return limitCents / 100;
}

function getSavedAlertAmountCents(alerts: BillingAlertsFormData): number {
  return Math.round(alerts.amount * 100);
}

function usesFractionAlertLevelFormat(levels: number[]): boolean {
  return levels.some((level) => level > 0 && level <= 1);
}

export type NormalizeBillingAlertsOptions = {
  planLimitCents: number;
  effectiveLimitCents: number;
};

function isAbsoluteDollarAlertAmount(rawAmount: number, alertLevels: number[]): boolean {
  if (rawAmount !== ABSOLUTE_ALERT_BASE_CENTS || alertLevels.length === 0) {
    return false;
  }

  // None-mode absolute alerts use the $1 base (100 cents) with dollar thresholds (e.g. 100, 250).
  // Legacy percentage alerts at amount=100 use UI percent values, with at least one below 100.
  const hasTypicalPercentLevel = alertLevels.some((level) => level > 0 && level < 100);

  return !hasTypicalPercentLevel;
}

/** Detect legacy alerts that stored the limit base in dollars with whole-number percents. */
export function isLegacyDollarAmountField(
  rawAmount: number,
  alertLevels: number[],
  options: NormalizeBillingAlertsOptions
): boolean {
  if (isAbsoluteDollarAlertAmount(rawAmount, alertLevels)) {
    return false;
  }

  if (!Number.isFinite(rawAmount) || rawAmount < 10) {
    return false;
  }

  if (alertLevels.length === 0 || usesFractionAlertLevelFormat(alertLevels)) {
    return false;
  }

  // Platform migrated $10+ limits to cents (e.g. 10_000 for $100).
  if (rawAmount >= 1000) {
    return false;
  }

  if (rawAmount === options.planLimitCents || rawAmount === options.effectiveLimitCents) {
    return false;
  }

  const planDollars = Math.round(options.planLimitCents / 100);
  const effectiveDollars = Math.round(options.effectiveLimitCents / 100);

  return rawAmount === planDollars || rawAmount === effectiveDollars;
}

function isAbsoluteDollarAlertLevels(levels: number[]): boolean {
  if (levels.length === 0) {
    return false;
  }

  return !usesFractionAlertLevelFormat(levels);
}

export function isAbsoluteSavedAlerts(alerts: BillingAlertsFormData): boolean {
  return getSavedAlertAmountCents(alerts) === ABSOLUTE_ALERT_BASE_CENTS;
}

/** Build a cleaned alerts payload when saving billing limits in the same alert format. */
export function buildCleanedAlertsPayloadForLimitSave(
  alerts: BillingAlertsFormData,
  nextMode: BillingLimitMode,
  effectiveLimitCents: number,
  planLimitCents: number
): { amount: number; alertLevels: number[]; emails: string[] } | null {
  if (alerts.alertLevels.length === 0) {
    return null;
  }

  const thresholds = storedAlertsToThresholds(
    alerts,
    nextMode,
    effectiveLimitCents,
    planLimitCents
  );

  return {
    emails: alerts.emails,
    ...thresholdsToAlertPayload(thresholds, nextMode, effectiveLimitCents),
  };
}

/** Convert stored percentage alert levels to UI percent values (10, 50, 80). */
export function percentageAlertLevelsToUiThresholds(levels: number[]): number[] {
  const normalized = levels.filter((level) => Number.isFinite(level) && level > 0);
  if (normalized.length === 0) {
    return [];
  }

  if (usesFractionAlertLevelFormat(normalized)) {
    return normalized.filter((level) => level <= 1).map((level) => Math.round(level * 100));
  }

  return normalized
    .filter((level) => level <= MAX_PERCENTAGE_THRESHOLD)
    .map((level) => Math.round(level));
}

export function normalizeBillingAlertsFromApi(
  apiAlerts: {
    amount: number;
    emails?: string[];
    alertLevels?: number[];
  },
  options: NormalizeBillingAlertsOptions
): BillingAlertsFormData {
  const rawAmount = Number(apiAlerts.amount);
  const alertLevels = (apiAlerts.alertLevels ?? []).map(Number).filter(Number.isFinite);

  // Platform API stores amount in cents.
  let amountDollars = rawAmount / 100;

  if (isLegacyDollarAmountField(rawAmount, alertLevels, options)) {
    amountDollars = rawAmount;
  }

  return {
    amount: amountDollars,
    emails: apiAlerts.emails ?? [],
    alertLevels,
  };
}

/** Legacy alerts used plan included usage; new alerts use the billing limit amount. */
function percentageAlertAmountMatches(
  amountCents: number,
  effectiveLimitCents: number,
  planLimitCents: number
): boolean {
  return amountCents === effectiveLimitCents || amountCents === planLimitCents;
}

/** Cents base for dollar preview when displaying saved percentage alerts. */
export function getAlertPreviewLimitCents(
  alerts: BillingAlertsFormData,
  effectiveLimitCents: number,
  planLimitCents: number
): number {
  const amountCents = getSavedAlertAmountCents(alerts);
  if (amountCents > 0 && percentageAlertLevelsToUiThresholds(alerts.alertLevels).length > 0) {
    return amountCents;
  }
  if (percentageAlertAmountMatches(amountCents, effectiveLimitCents, planLimitCents)) {
    return amountCents;
  }
  return effectiveLimitCents;
}

/** Convert stored API alerts to UI threshold values (percent or dollars). */
export function storedAlertsToThresholds(
  alerts: BillingAlertsFormData,
  mode: BillingLimitMode,
  effectiveLimitCents: number,
  planLimitCents: number
): number[] {
  const amountCents = getSavedAlertAmountCents(alerts);

  if (mode === "none") {
    if (alerts.alertLevels.length === 0) {
      return [];
    }

    // Absolute dollar alerts: API amount is the $1 base marker (100 cents).
    if (
      amountCents === ABSOLUTE_ALERT_BASE_CENTS ||
      alerts.amount === ABSOLUTE_ALERT_BASE_CENTS / 100
    ) {
      return alerts.alertLevels.slice(0, MAX_ABSOLUTE_ALERTS);
    }

    return [];
  }

  const uiThresholds = percentageAlertLevelsToUiThresholds(alerts.alertLevels);
  if (uiThresholds.length === 0) {
    return [];
  }

  // Saved percentage alerts keep their thresholds whenever a positive base amount is stored.
  if (amountCents > 0) {
    return uiThresholds.slice(0, MAX_PERCENTAGE_ALERTS);
  }

  return [];
}

export function thresholdsToAlertPayload(
  thresholds: number[],
  mode: BillingLimitMode,
  effectiveLimitCents: number
): { amount: number; alertLevels: number[] } {
  if (mode === "none") {
    return {
      amount: ABSOLUTE_ALERT_BASE_CENTS,
      alertLevels: thresholds,
    };
  }

  return {
    amount: effectiveLimitCents,
    alertLevels: thresholds.map((percent) => percent / 100),
  };
}

export function isEmptyThreshold(value: number): boolean {
  return !Number.isFinite(value) || value <= 0;
}

export function previewDollarAmountForPercent(
  percent: number,
  effectiveLimitCents: number
): number {
  if (!Number.isFinite(percent) || percent <= 0) {
    return 0;
  }
  return (effectiveLimitCents * percent) / 100 / 100;
}

/** Legacy percentage alerts may include spike multipliers above 100%. */
export function hasLegacySpikeAlertLevels(
  alerts: BillingAlertsFormData,
  mode: BillingLimitMode,
  effectiveLimitCents: number,
  planLimitCents: number
): boolean {
  if (!isPercentageAlertMode(mode)) {
    return false;
  }

  if (usesFractionAlertLevelFormat(alerts.alertLevels)) {
    return alerts.alertLevels.some((level) => level > 1);
  }

  return alerts.alertLevels.some((level) => level > MAX_PERCENTAGE_THRESHOLD);
}
