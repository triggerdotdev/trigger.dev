import { DisplayProperty, EventSpecification, EventSpecificationExample } from "@trigger.dev/sdk";
import {
  DeletedPayload,
  DeliveryProfile,
  Market,
  PaymentSchedule,
  ProductListingRemoved,
  SellingPlanGroup,
  SellingPlanGroupDeleted,
  ShopLocale,
  SubscriptionBillingAttempt,
  SubscriptionBillingCycle,
  SubscriptionContract,
  WebhookTopic,
} from "./schemas";
import { basicProperties } from "./utils";
import * as eg from "./payload-examples";
import { ShopifyWebhookPayload } from "./types";
import { titleCase } from "@trigger.dev/integration-kit/utils";

const eventSpec = <TEvent>({
  topic,
  examples,
  runProperties,
}: {
  topic: WebhookTopic;
  examples?: EventSpecificationExample[];
  runProperties?: (payload: TEvent) => DisplayProperty[];
}): EventSpecification<TEvent> => {
  return {
    name: topic,
    title: topicToTitle(topic),
    source: "shopify.com",
    icon: "shopify",
    examples,
    parsePayload: (payload) => payload as TEvent,
    runProperties,
  };
};

const topicToTitle = (topic: WebhookTopic) => {
  const prettyTopic = titleCase(topic.replace("_", " ").replace("/", " "));
  return `On ${prettyTopic}`;
};

export const onFulfillmentCreated = eventSpec<ShopifyWebhookPayload["Fulfillment"]>({
  topic: "fulfillments/create",
  examples: [eg.fulfillmentCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onFulfillmentUpdated = eventSpec<ShopifyWebhookPayload["Fulfillment"]>({
  topic: "fulfillments/update",
  examples: [eg.fulfillmentUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onInventoryItemCreated = eventSpec<ShopifyWebhookPayload["InventoryItem"]>({
  topic: "inventory_items/create",
  examples: [eg.inventoryItemCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onInventoryItemDeleted = eventSpec<DeletedPayload>({
  topic: "inventory_items/delete",
  examples: [eg.inventoryItemDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onInventoryItemUpdated = eventSpec<ShopifyWebhookPayload["InventoryItem"]>({
  topic: "inventory_items/update",
  examples: [eg.inventoryItemUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onInventoryLevelConnected = eventSpec<ShopifyWebhookPayload["InventoryLevel"]>({
  topic: "inventory_levels/connect",
  examples: [eg.inventoryLevelConnected],
});
export const onInventoryLevelDisconnected = eventSpec<ShopifyWebhookPayload["InventoryLevel"]>({
  topic: "inventory_levels/disconnect",
  examples: [eg.inventoryLevelDisconnected],
});
export const onInventoryLevelUpdated = eventSpec<ShopifyWebhookPayload["InventoryLevel"]>({
  topic: "inventory_levels/update",
  examples: [eg.inventoryLevelUpdated],
});

export const onLocaleCreated = eventSpec<ShopLocale>({
  topic: "locales/create",
  examples: [eg.localeCreated],
});
export const onLocaleUpdated = eventSpec<ShopLocale>({
  topic: "locales/update",
  examples: [eg.localeUpdated],
});

export const onLocationActivated = eventSpec<ShopifyWebhookPayload["Location"]>({
  topic: "locations/activate",
  examples: [eg.locationActivated],
  runProperties: (payload) => basicProperties(payload),
});
export const onLocationCreated = eventSpec<ShopifyWebhookPayload["Location"]>({
  topic: "locations/create",
  examples: [eg.locationCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onLocationDeactivated = eventSpec<ShopifyWebhookPayload["Location"]>({
  topic: "locations/deactivate",
  examples: [eg.locationDeactivated],
  runProperties: (payload) => basicProperties(payload),
});
export const onLocationDeleted = eventSpec<ShopifyWebhookPayload["Location"]>({
  topic: "locations/delete",
  examples: [eg.locationDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onLocationUpdated = eventSpec<ShopifyWebhookPayload["Location"]>({
  topic: "locations/update",
  examples: [eg.locationUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onMarketCreated = eventSpec<Market>({
  topic: "markets/create",
  examples: [eg.marketCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onMarketDeleted = eventSpec<DeletedPayload>({
  topic: "markets/delete",
  examples: [eg.marketDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onMarketUpdated = eventSpec<Market>({
  topic: "markets/update",
  examples: [eg.marketUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onOrderCancelled = eventSpec<ShopifyWebhookPayload["Order"]>({
  topic: "orders/cancelled",
  examples: [eg.orderCancelled],
  runProperties: (payload) => basicProperties(payload),
});
export const onOrderCreated = eventSpec<ShopifyWebhookPayload["Order"]>({
  topic: "orders/create",
  examples: [eg.orderCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onOrderDeleted = eventSpec<DeletedPayload>({
  topic: "orders/delete",
  examples: [eg.orderDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onOrderEdited = eventSpec<ShopifyWebhookPayload["Order"]>({
  topic: "orders/edited",
  examples: [eg.orderEdited],
  runProperties: (payload) => basicProperties(payload),
});
export const onOrderFulfilled = eventSpec<ShopifyWebhookPayload["Order"]>({
  topic: "orders/fulfilled",
  examples: [eg.orderFulfilled],
  runProperties: (payload) => basicProperties(payload),
});
export const onOrderPaid = eventSpec<ShopifyWebhookPayload["Order"]>({
  topic: "orders/paid",
  examples: [eg.orderPaid],
  runProperties: (payload) => basicProperties(payload),
});
export const onOrderPartiallyFulfilled = eventSpec<ShopifyWebhookPayload["Order"]>({
  topic: "orders/partially_fulfilled",
  examples: [eg.orderPartiallyFulfilled],
  runProperties: (payload) => basicProperties(payload),
});
export const onOrderUpdated = eventSpec<ShopifyWebhookPayload["Order"]>({
  topic: "orders/updated",
  examples: [eg.orderUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onPaymentScheduleDue = eventSpec<PaymentSchedule>({
  topic: "payment_schedules/due",
  examples: [eg.paymentScheduleDue],
  runProperties: (payload) => basicProperties(payload),
});

export const onProductCreated = eventSpec<ShopifyWebhookPayload["Product"]>({
  topic: "products/create",
  examples: [eg.productCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onProductDeleted = eventSpec<DeletedPayload>({
  topic: "products/delete",
  examples: [eg.productDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onProductUpdated = eventSpec<ShopifyWebhookPayload["Product"]>({
  topic: "products/update",
  examples: [eg.productUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onProductListingAdded = eventSpec<ShopifyWebhookPayload["ProductListing"]>({
  topic: "product_listings/add",
  examples: [eg.productlistingAdded],
});
export const onProductListingRemoved = eventSpec<ProductListingRemoved>({
  topic: "product_listings/remove",
  examples: [eg.productListingRemoved],
});
export const onProductListingUpdated = eventSpec<ShopifyWebhookPayload["ProductListing"]>({
  topic: "product_listings/update",
  examples: [eg.productListingUpdated],
});

export const onDeliveryProfileCreated = eventSpec<DeliveryProfile>({
  topic: "profiles/create",
  examples: [eg.deliveryProfileCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onDeliveryProfileDeleted = eventSpec<DeletedPayload>({
  topic: "profiles/delete",
  examples: [eg.deliveryProfileDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onDeliveryProfileUpdated = eventSpec<DeliveryProfile>({
  topic: "profiles/update",
  examples: [eg.deliveryProfileUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onRefundCreated = eventSpec<ShopifyWebhookPayload["Refund"]>({
  topic: "profiles/create",
  examples: [eg.refundCreated],
  runProperties: (payload) => basicProperties(payload),
});

export const onSellingPlanGroupCreated = eventSpec<SellingPlanGroup>({
  topic: "selling_plan_groups/create",
  examples: [eg.sellingPlanGroupCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onSellingPlanGroupDeleted = eventSpec<SellingPlanGroupDeleted>({
  topic: "selling_plan_groups/delete",
  examples: [eg.sellingPlanGroupDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onSellingPlanGroupUpdated = eventSpec<SellingPlanGroup>({
  topic: "selling_plan_groups/update",
  examples: [eg.sellingPlanGroupUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onShopUpdated = eventSpec<ShopifyWebhookPayload["Shop"]>({
  topic: "profiles/update",
  examples: [eg.shopUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onSubscriptionBillingAttemptChallenged = eventSpec<SubscriptionBillingAttempt>({
  topic: "subscription_billing_attempts/challenged",
  examples: [eg.subscriptionBillingAttemptChallenged],
  runProperties: (payload) => basicProperties(payload),
});
export const onSubscriptionBillingAttemptFailure = eventSpec<SubscriptionBillingAttempt>({
  topic: "subscription_billing_attempts/failure",
  examples: [eg.subscriptionBillingAttemptFailure],
  runProperties: (payload) => basicProperties(payload),
});
export const onSubscriptionBillingAttemptSuccess = eventSpec<SubscriptionBillingAttempt>({
  topic: "subscription_billing_attempts/success",
  examples: [eg.subscriptionBillingAttemptSuccess],
  runProperties: (payload) => basicProperties(payload),
});

export const onSubscriptionBillingCycleCreated = eventSpec<SubscriptionBillingCycle>({
  topic: "subscription_billing_cycle_edits/create",
  examples: [eg.subscriptionBillingCycleCreated],
});
export const onSubscriptionBillingCycleDeleted = eventSpec<DeletedPayload>({
  topic: "subscription_billing_cycle_edits/delete",
  examples: [eg.subscriptionBillingCycleDeleted],
});
export const onSubscriptionBillingCycleUpdated = eventSpec<SubscriptionBillingCycle>({
  topic: "subscription_billing_cycle_edits/update",
  examples: [eg.subscriptionBillingCycleUpdated],
});

export const onSubscriptionContractCreated = eventSpec<SubscriptionContract>({
  topic: "subscription_contracts/create",
  examples: [eg.subscriptionContractCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onSubscriptionContractUpdated = eventSpec<SubscriptionContract>({
  topic: "subscription_contracts/update",
  examples: [eg.subscriptionContractUpdated],
  runProperties: (payload) => basicProperties(payload),
});

export const onTenderTransactionCreated = eventSpec<ShopifyWebhookPayload["TenderTransaction"]>({
  topic: "tender_transactions/create",
  examples: [eg.tenderTransactionCreated],
  runProperties: (payload) => basicProperties(payload),
});

export const onThemeCreated = eventSpec<ShopifyWebhookPayload["Theme"]>({
  topic: "themes/create",
  examples: [eg.themeCreated],
  runProperties: (payload) => basicProperties(payload),
});
export const onThemeDeleted = eventSpec<DeletedPayload>({
  topic: "themes/delete",
  examples: [eg.themeDeleted],
  runProperties: (payload) => basicProperties(payload),
});
export const onThemePublished = eventSpec<ShopifyWebhookPayload["Theme"]>({
  topic: "themes/publish",
  examples: [eg.themePublished],
  runProperties: (payload) => basicProperties(payload),
});
export const onThemeUpdated = eventSpec<ShopifyWebhookPayload["Theme"]>({
  topic: "themes/update",
  examples: [eg.themeUpdated],
  runProperties: (payload) => basicProperties(payload),
});
