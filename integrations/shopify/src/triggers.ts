import { z } from "zod";
import * as events from "./events";
import { DeletedPayload, WebhookTopic } from "./schemas";
import { EventSpecification } from "@trigger.dev/sdk";
import { TriggerParams } from "./webhooks";
import { entries, fromEntries } from "@trigger.dev/integration-kit/utils";
import { ShopifyWebhookPayload } from "./types";

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
  "app/uninstalled": events.eventSpec<any>({ topic: "app/uninstalled" }),
  "app_subscriptions/update": events.eventSpec<any>({ topic: "app_subscriptions/update" }),
  "bulk_operations/finish": events.eventSpec<any>({ topic: "bulk_operations/finish" }),
  "carts/create": events.eventSpec<any>({ topic: "carts/create" }),
  "carts/update": events.eventSpec<any>({ topic: "carts/update" }),
  "checkouts/create": events.eventSpec<ShopifyWebhookPayload["Checkout"]>({ topic: "checkouts/create" }),
  "checkouts/delete": events.eventSpec<DeletedPayload>({ topic: "checkouts/delete" }),
  "checkouts/update": events.eventSpec<ShopifyWebhookPayload["Checkout"]>({ topic: "checkouts/update" }),
  "collection_listings/add": events.eventSpec<ShopifyWebhookPayload["CollectionListing"]>({ topic: "collection_listings/add" }),
  "collection_listings/remove": events.eventSpec<DeletedPayload>({ topic: "collection_listings/remove" }),
  "collection_listings/update": events.eventSpec<ShopifyWebhookPayload["CollectionListing"]>({ topic: "collection_listings/update" }),
  "collections/create": events.eventSpec<ShopifyWebhookPayload["Collection"]>({ topic: "collections/create" }),
  "collections/delete": events.eventSpec<DeletedPayload>({ topic: "collections/delete" }),
  "collections/update": events.eventSpec<ShopifyWebhookPayload["Collection"]>({ topic: "collections/update" }),
  "companies/create": events.eventSpec<any>({ topic: "companies/create" }),
  "companies/delete": events.eventSpec<DeletedPayload>({ topic: "companies/delete" }),
  "companies/update": events.eventSpec<any>({ topic: "companies/update" }),
  "company_contact_roles/assign": events.eventSpec<any>({ topic: "company_contact_roles/assign" }),
  "company_contact_roles/revoke": events.eventSpec<any>({ topic: "company_contact_roles/revoke" }),
  "company_contacts/create": events.eventSpec<any>({ topic: "company_contacts/create" }),
  "company_contacts/delete": events.eventSpec<DeletedPayload>({ topic: "company_contacts/delete" }),
  "company_contacts/update": events.eventSpec<any>({ topic: "company_contacts/update" }),
  "company_locations/create": events.eventSpec<any>({ topic: "company_locations/create" }),
  "company_locations/delete": events.eventSpec<DeletedPayload>({ topic: "company_locations/delete" }),
  "company_locations/update": events.eventSpec<any>({ topic: "company_locations/update" }),
  "customer_groups/create": events.eventSpec<any>({ topic: "customer_groups/create" }),
  "customer_groups/delete": events.eventSpec<DeletedPayload>({ topic: "customer_groups/delete" }),
  "customer_groups/update": events.eventSpec<any>({ topic: "customer_groups/update" }),
  "customer_payment_methods/create": events.eventSpec<any>({ topic: "customer_payment_methods/create" }),
  "customer_payment_methods/revoke": events.eventSpec<any>({ topic: "customer_payment_methods/revoke" }),
  "customer_payment_methods/update": events.eventSpec<any>({ topic: "customer_payment_methods/update" }),
  "customers/create": events.eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/create" }),
  "customers/delete": events.eventSpec<DeletedPayload>({ topic: "customers/delete" }),
  "customers/disable": events.eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/disable" }),
  "customers/enable": events.eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/enable" }),
  "customers/merge": events.eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/merge" }),
  "customers/update": events.eventSpec<ShopifyWebhookPayload["Customer"]>({ topic: "customers/update" }),
  "customers_email_marketing_consent/update": events.eventSpec<any>({ topic: "customers_email_marketing_consent/update" }),
  "customers_marketing_consent/update": events.eventSpec<any>({ topic: "customers_marketing_consent/update" }),
  "disputes/create": events.eventSpec<ShopifyWebhookPayload["Dispute"]>({ topic: "disputes/create" }),
  "disputes/update": events.eventSpec<ShopifyWebhookPayload["Dispute"]>({ topic: "disputes/update" }),
  "domains/create": events.eventSpec<any>({ topic: "domains/create" }),
  "domains/destroy": events.eventSpec<DeletedPayload>({ topic: "domains/destroy" }),
  "domains/update": events.eventSpec<any>({ topic: "domains/update" }),
  "draft_orders/create": events.eventSpec<ShopifyWebhookPayload["DraftOrder"]>({ topic: "draft_orders/create" }),
  "draft_orders/delete": events.eventSpec<DeletedPayload>({ topic: "draft_orders/delete" }),
  "draft_orders/update": events.eventSpec<ShopifyWebhookPayload["DraftOrder"]>({ topic: "draft_orders/update" }),
  "fulfillment_events/create": events.eventSpec<ShopifyWebhookPayload["FulfillmentEvent"]>({ topic: "fulfillment_events/create" }),
  "fulfillment_events/delete": events.eventSpec<DeletedPayload>({ topic: "fulfillment_events/delete" }),
  "fulfillment_orders/cancellation_request_accepted": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancellation_request_accepted" }),
  "fulfillment_orders/cancellation_request_rejected": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancellation_request_rejected" }),
  "fulfillment_orders/cancellation_request_submitted": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancellation_request_submitted" }),
  "fulfillment_orders/cancelled": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/cancelled" }),
  "fulfillment_orders/fulfillment_request_accepted": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_request_accepted" }),
  "fulfillment_orders/fulfillment_request_rejected": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_request_rejected" }),
  "fulfillment_orders/fulfillment_request_submitted": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_request_submitted" }),
  "fulfillment_orders/fulfillment_service_failed_to_complete": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/fulfillment_service_failed_to_complete" }),
  "fulfillment_orders/hold_released": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/hold_released" }),
  "fulfillment_orders/line_items_prepared_for_local_delivery": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/line_items_prepared_for_local_delivery" }),
  "fulfillment_orders/line_items_prepared_for_pickup": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/line_items_prepared_for_pickup" }),
  "fulfillment_orders/moved": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/moved" }),
  "fulfillment_orders/order_routing_complete": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/order_routing_complete" }),
  "fulfillment_orders/placed_on_hold": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/placed_on_hold" }),
  "fulfillment_orders/rescheduled": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/rescheduled" }),
  "fulfillment_orders/scheduled_fulfillment_order_ready": events.eventSpec<ShopifyWebhookPayload["FulfillmentOrder"]>({ topic: "fulfillment_orders/scheduled_fulfillment_order_ready" }),
  "order_transactions/create": events.eventSpec<ShopifyWebhookPayload["Transaction"]>({ topic: "order_transactions/create" }),
  "product_feeds/create": events.eventSpec<any>({ topic: "product_feeds/create" }),
  "product_feeds/full_sync": events.eventSpec<any>({ topic: "product_feeds/full_sync" }),
  "product_feeds/incremental_sync": events.eventSpec<any>({ topic: "product_feeds/incremental_sync" }),
  "scheduled_product_listings/add": events.eventSpec<any>({ topic: "scheduled_product_listings/add" }),
  "scheduled_product_listings/remove": events.eventSpec<DeletedPayload>({ topic: "scheduled_product_listings/remove" }),
  "scheduled_product_listings/update": events.eventSpec<any>({ topic: "scheduled_product_listings/update" }),
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
