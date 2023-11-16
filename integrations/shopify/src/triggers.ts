import { z } from "zod";
import * as events from "./events";
import { WebhookTopic } from "./schemas";
import { EventSpecification } from "@trigger.dev/sdk";
import { TriggerParams } from "./webhooks";
import { entries, fromEntries } from "@trigger.dev/integration-kit/utils";

const TriggerConfigSchema = z.object({
  fields: z.string().array().optional(),
});

type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

type TriggerCatalog<TEventName extends string> = {
  [K in TEventName]: {
    eventSpec: EventSpecification<any>;
    params: Pick<TriggerParams, "topic">;
  };
};

type TopicCatalog<TEventName extends string> = {
  [K in TEventName]: EventSpecification<any>;
};

const catalogEntry = (
  topic: WebhookTopic,
  eventSpec: EventSpecification<any>
): TriggerCatalog<WebhookTopic>[WebhookTopic] => {
  return {
    params: { topic },
    eventSpec,
  };
};

const topicCatalog: TopicCatalog<WebhookTopic> = {
  "fulfillments/create": events.onFulfillmentCreated,
  "fulfillments/update": events.onFulfillmentUpdated,
  "inventory_items/create": events.onInventoryItemCreated,
  "inventory_items/delete": events.onInventoryItemDeleted,
  "inventory_items/update": events.onInventoryItemUpdated,
  "inventory_levels/connect": events.onInventoryLevelConnected,
  "inventory_levels/disconnect": events.onInventoryLevelDisconnected,
  "inventory_levels/update": events.onInventoryLevelUpdated,
  "locales/create": events.onLocaleCreated,
  "locales/update": events.onLocaleUpdated,
  "locations/activate": events.onLocationActivated,
  "locations/create": events.onLocationCreated,
  "locations/deactivate": events.onLocationDeactivated,
  "locations/delete": events.onLocationDeleted,
  "locations/update": events.onLocationUpdated,
  "markets/create": events.onMarketCreated,
  "markets/delete": events.onMarketDeleted,
  "markets/update": events.onMarketUpdated,
  "orders/cancelled": events.onOrderCancelled,
  "orders/create": events.onOrderCreated,
  "orders/delete": events.onOrderDeleted,
  "orders/edited": events.onOrderEdited,
  "orders/fulfilled": events.onOrderFulfilled,
  "orders/paid": events.onOrderPaid,
  "orders/partially_fulfilled": events.onOrderPartiallyFulfilled,
  "orders/updated": events.onOrderUpdated,
  "payment_schedules/due": events.onPaymentScheduleDue,
  "product_listings/add": events.onProductListingAdded,
  "product_listings/remove": events.onProductListingRemoved,
  "product_listings/update": events.onProductListingUpdated,
  "products/create": events.onProductCreated,
  "products/delete": events.onProductDeleted,
  "products/update": events.onProductUpdated,
  "profiles/create": events.onDeliveryProfileCreated,
  "profiles/delete": events.onDeliveryProfileDeleted,
  "profiles/update": events.onDeliveryProfileUpdated,
  "refunds/create": events.onRefundCreated,
  "selling_plan_groups/create": events.onSellingPlanGroupCreated,
  "selling_plan_groups/delete": events.onSellingPlanGroupDeleted,
  "selling_plan_groups/update": events.onSellingPlanGroupUpdated,
  "shop/update": events.onShopUpdated,
  "subscription_billing_attempts/challenged": events.onSubscriptionBillingAttemptChallenged,
  "subscription_billing_attempts/failure": events.onSubscriptionBillingAttemptFailure,
  "subscription_billing_attempts/success": events.onSubscriptionBillingAttemptSuccess,
  "subscription_billing_cycle_edits/create": events.onSubscriptionBillingCycleCreated,
  "subscription_billing_cycle_edits/delete": events.onSubscriptionBillingCycleDeleted,
  "subscription_billing_cycle_edits/update": events.onSubscriptionBillingCycleUpdated,
  "subscription_contracts/create": events.onSubscriptionContractCreated,
  "subscription_contracts/update": events.onSubscriptionContractUpdated,
  "tender_transactions/create": events.onTenderTransactionCreated,
  "themes/create": events.onThemeCreated,
  "themes/delete": events.onThemeDeleted,
  "themes/publish": events.onThemePublished,
  "themes/update": events.onThemeUpdated,
};

export const triggerCatalog: TriggerCatalog<WebhookTopic> = fromEntries(
  entries(topicCatalog).map(([topic, eventSpec]) => {
    return [topic, catalogEntry(topic, eventSpec)];
  })
);
