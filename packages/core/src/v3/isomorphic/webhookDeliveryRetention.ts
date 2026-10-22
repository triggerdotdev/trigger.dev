/**
 * How long webhook deliveries are kept. Each class is one LIST partition of `WebhookDelivery`, itself
 * RANGE-partitioned on `createdAt` into day or week leaves, and expired leaves are dropped whole. The
 * class is stamped on a delivery when it's written and encoded in its id, so a retention change only
 * applies to new deliveries.
 *
 * `code` is the class char in a v2 delivery id. Append new classes; never reuse or reorder codes.
 */
export type WebhookDeliveryRetentionClass = {
  code: string;
  days: number;
  period: "day" | "week";
};

export const WEBHOOK_DELIVERY_RETENTION_CLASSES: readonly WebhookDeliveryRetentionClass[] = [
  { code: "0", days: 3, period: "day" },
  { code: "1", days: 7, period: "day" },
  { code: "2", days: 30, period: "day" },
  { code: "3", days: 90, period: "week" },
  { code: "4", days: 180, period: "week" },
  { code: "5", days: 365, period: "week" },
];

const CLASSES_BY_DAYS = [...WEBHOOK_DELIVERY_RETENTION_CLASSES].sort((a, b) => a.days - b.days);

/** The class for an exact number of days, if there is one. */
export function webhookDeliveryRetentionClass(
  days: number
): WebhookDeliveryRetentionClass | undefined {
  return WEBHOOK_DELIVERY_RETENTION_CLASSES.find((c) => c.days === days);
}

/** The smallest class that keeps deliveries at least `days`, or the longest class past that. */
export function webhookDeliveryRetentionClassAtLeast(days: number): WebhookDeliveryRetentionClass {
  return (
    CLASSES_BY_DAYS.find((c) => c.days >= days) ?? CLASSES_BY_DAYS[CLASSES_BY_DAYS.length - 1]!
  );
}

export function webhookDeliveryRetentionClassByCode(
  code: string
): WebhookDeliveryRetentionClass | undefined {
  return WEBHOOK_DELIVERY_RETENTION_CLASSES.find((c) => c.code === code);
}
