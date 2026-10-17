import { type WebhookDeliveryStatus } from "@trigger.dev/database";

/** Every delivery status, in the order the status filter lists them. */
export const DELIVERY_STATUS_FILTERS = [
  "SUCCEEDED",
  "FAILED",
  "PROCESSING",
  "PENDING",
  "FILTERED",
  "UNMATCHED",
] as const satisfies readonly WebhookDeliveryStatus[];

export const LIVE_DELIVERY_MODE = "live";
export const TEST_DELIVERY_MODE = "test";

/** The URL params the deliveries filters own: the live poll forwards them, so its count matches. */
export const DELIVERY_FILTER_PARAMS = ["statuses", "mode", "deliveryId"] as const;

export type DeliveryListFilters = {
  statuses?: WebhookDeliveryStatus[];
  /** Undefined when both live and test deliveries are shown. */
  isTest?: boolean;
  /** A delivery friendlyId or the provider's external delivery id. */
  deliveryId?: string;
};

function repeated(searchParams: URLSearchParams, key: string): string[] {
  const values = searchParams
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(values));
}

/** Parse the deliveries filters from a page or live-poll URL, dropping values it doesn't know. */
export function parseDeliveryListFilters(searchParams: URLSearchParams): DeliveryListFilters {
  const statuses = repeated(searchParams, "statuses").filter(
    (status): status is WebhookDeliveryStatus =>
      (DELIVERY_STATUS_FILTERS as readonly string[]).includes(status)
  );

  // Picking both modes is the same as picking neither.
  const modes = repeated(searchParams, "mode");
  const showsLive = modes.includes(LIVE_DELIVERY_MODE);
  const showsTest = modes.includes(TEST_DELIVERY_MODE);
  const isTest = showsLive === showsTest ? undefined : showsTest;

  const deliveryId = searchParams.get("deliveryId")?.trim() || undefined;

  return {
    statuses: statuses.length > 0 ? statuses : undefined,
    isTest,
    deliveryId,
  };
}

export function hasDeliveryListFilters(filters: DeliveryListFilters): boolean {
  return Boolean(filters.statuses || filters.isTest !== undefined || filters.deliveryId);
}
