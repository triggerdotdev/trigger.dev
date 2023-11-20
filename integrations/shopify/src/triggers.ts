import { z } from "zod";
import * as events from "./events";
import { DeletedPayload, WebhookTopic } from "./schemas";
import { EventSpecification } from "@trigger.dev/sdk";
import { entries, fromEntries } from "@trigger.dev/integration-kit/utils";
import { ShopifyWebhookPayload, TriggerParams } from "./types";
import { eventSpec } from "./utils";

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

// TODO: verify delete payloads
const eventsWithoutExamples = {
  "app/uninstalled": eventSpec<any>({ topic: "app/uninstalled" }),
  "app_subscriptions/update": eventSpec<any>({ topic: "app_subscriptions/update" }),
  "bulk_operations/finish": eventSpec<any>({ topic: "bulk_operations/finish" }),
  "carts/create": eventSpec<any>({ topic: "carts/create" }),
  "carts/update": eventSpec<any>({ topic: "carts/update" }),
  "checkouts/create": eventSpec<ShopifyWebhookPayload["Checkout"]>({ topic: "checkouts/create" }),
  "checkouts/delete": eventSpec<DeletedPayload>({ topic: "checkouts/delete" }),
  "checkouts/update": eventSpec<ShopifyWebhookPayload["Checkout"]>({ topic: "checkouts/update" }),
  "collection_listings/add": eventSpec<ShopifyWebhookPayload["CollectionListing"]>({ topic: "collection_listings/add" }),
  "collection_listings/remove": eventSpec<DeletedPayload>({ topic: "collection_listings/remove" }),
  "collection_listings/update": eventSpec<ShopifyWebhookPayload["CollectionListing"]>({ topic: "collection_listings/update" }),
  "collections/create": eventSpec<ShopifyWebhookPayload["Collection"]>({ topic: "collections/create" }),
  "collections/delete": eventSpec<DeletedPayload>({ topic: "collections/delete" }),
  "collections/update": eventSpec<ShopifyWebhookPayload["Collection"]>({ topic: "collections/update" }),
  "companies/create": eventSpec<any>({ topic: "companies/create" }),
  "companies/delete": eventSpec<DeletedPayload>({ topic: "companies/delete" }),
  "companies/update": eventSpec<any>({ topic: "companies/update" }),
  "company_contact_roles/assign": eventSpec<any>({ topic: "company_contact_roles/assign" }),
  "company_contact_roles/revoke": eventSpec<any>({ topic: "company_contact_roles/revoke" }),
  "company_contacts/create": eventSpec<any>({ topic: "company_contacts/create" }),
  "company_contacts/delete": eventSpec<DeletedPayload>({ topic: "company_contacts/delete" }),
  "company_contacts/update": eventSpec<any>({ topic: "company_contacts/update" }),
  "company_locations/create": eventSpec<any>({ topic: "company_locations/create" }),
  "company_locations/delete": eventSpec<DeletedPayload>({ topic: "company_locations/delete" }),
  "company_locations/update": eventSpec<any>({ topic: "company_locations/update" }),
  "customer_groups/create": eventSpec<any>({ topic: "customer_groups/create" }),
  "customer_groups/delete": eventSpec<DeletedPayload>({ topic: "customer_groups/delete" }),
  "customer_groups/update": eventSpec<any>({ topic: "customer_groups/update" }),
  "customer_payment_methods/create": eventSpec<any>({ topic: "customer_payment_methods/create" }),
  "customer_payment_methods/revoke": eventSpec<any>({ topic: "customer_payment_methods/revoke" }),
  "customer_payment_methods/update": eventSpec<any>({ topic: "customer_payment_methods/update" }),
  "customers/create": eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/create" }),
  "customers/delete": eventSpec<DeletedPayload>({ topic: "customers/delete" }),
  "customers/disable": eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/disable" }),
  "customers/enable": eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/enable" }),
  "customers/merge": eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/merge" }),
  "customers/update": eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/update" }),
  "customers_email_marketing_consent/update": eventSpec<any>({ topic: "customers_email_marketing_consent/update" }),
  "customers_marketing_consent/update": eventSpec<any>({ topic: "customers_marketing_consent/update" }),
  "disputes/create": eventSpec<ShopifyWebhookPayload["Dispute"]>({ topic: "disputes/create" }),
  "disputes/update": eventSpec<ShopifyWebhookPayload["Dispute"]>({ topic: "disputes/update" }),
  "domains/create": eventSpec<any>({ topic: "domains/create" }),
  "domains/destroy": eventSpec<DeletedPayload>({ topic: "domains/destroy" }),
  "domains/update": eventSpec<any>({ topic: "domains/update" }),
  "draft_orders/create": eventSpec<ShopifyWebhookPayload["DraftOrder"]>({ topic: "draft_orders/create" }),
  "draft_orders/delete": eventSpec<DeletedPayload>({ topic: "draft_orders/delete" }),
  "draft_orders/update": eventSpec<ShopifyWebhookPayload["DraftOrder"]>({ topic: "draft_orders/update" }),
  "fulfillment_events/create": eventSpec<ShopifyWebhookPayload["FulfillmentEvent"]>({ topic: "fulfillment_events/create" }),
  "fulfillment_events/delete": eventSpec<DeletedPayload>({ topic: "fulfillment_events/delete" }),
  "fulfillment_orders/cancellation_request_accepted": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancellation_request_accepted" }),
  "fulfillment_orders/cancellation_request_rejected": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancellation_request_rejected" }),
  "fulfillment_orders/cancellation_request_submitted": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancellation_request_submitted" }),
  "fulfillment_orders/cancelled": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancelled" }),
  "fulfillment_orders/fulfillment_request_accepted": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_request_accepted" }),
  "fulfillment_orders/fulfillment_request_rejected": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_request_rejected" }),
  "fulfillment_orders/fulfillment_request_submitted": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_request_submitted" }),
  "fulfillment_orders/fulfillment_service_failed_to_complete": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_service_failed_to_complete" }),
  "fulfillment_orders/hold_released": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/hold_released" }),
  "fulfillment_orders/line_items_prepared_for_local_delivery": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/line_items_prepared_for_local_delivery" }),
  "fulfillment_orders/line_items_prepared_for_pickup": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/line_items_prepared_for_pickup" }),
  "fulfillment_orders/moved": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/moved" }),
  "fulfillment_orders/order_routing_complete": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/order_routing_complete" }),
  "fulfillment_orders/placed_on_hold": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/placed_on_hold" }),
  "fulfillment_orders/rescheduled": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/rescheduled" }),
  "fulfillment_orders/scheduled_fulfillment_order_ready": eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/scheduled_fulfillment_order_ready" }),
  "order_transactions/create": eventSpec<ShopifyWebhookPayload["Transaction"]>({ topic: "order_transactions/create" }),
  "product_feeds/create": eventSpec<any>({ topic: "product_feeds/create" }),
  "product_feeds/full_sync": eventSpec<any>({ topic: "product_feeds/full_sync" }),
  "product_feeds/incremental_sync": eventSpec<any>({ topic: "product_feeds/incremental_sync" }),
  "scheduled_product_listings/add": eventSpec<any>({ topic: "scheduled_product_listings/add" }),
  "scheduled_product_listings/remove": eventSpec<DeletedPayload>({ topic: "scheduled_product_listings/remove" }),
  "scheduled_product_listings/update": eventSpec<any>({ topic: "scheduled_product_listings/update" }),
};

const topicCatalog: TopicCatalog<WebhookTopic> = {
  ...eventsWithoutExamples,
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
