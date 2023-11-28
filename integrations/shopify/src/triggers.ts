import {
  EventSpecification,
  GetWebhookParams,
  WebhookSource,
  WebhookTrigger,
} from "@trigger.dev/sdk";
import { shopifyEvent } from "./events";
import { createWebhookEventSource } from "./webhooks";

const shopifyEvents = {
  "app/uninstalled": shopifyEvent("app/uninstalled"),
  "app_subscriptions/update": shopifyEvent("app_subscriptions/update"),
  "bulk_operations/finish": shopifyEvent("bulk_operations/finish"),
  "carts/create": shopifyEvent("carts/create"),
  "carts/update": shopifyEvent("carts/update"),
  "checkouts/create": shopifyEvent("checkouts/create"),
  "checkouts/delete": shopifyEvent("checkouts/delete"),
  "checkouts/update": shopifyEvent("checkouts/update"),
  "collection_listings/add": shopifyEvent("collection_listings/add"),
  "collection_listings/remove": shopifyEvent("collection_listings/remove"),
  "collection_listings/update": shopifyEvent("collection_listings/update"),
  "collections/create": shopifyEvent("collections/create"),
  "collections/delete": shopifyEvent("collections/delete"),
  "collections/update": shopifyEvent("collections/update"),
  "companies/create": shopifyEvent("companies/create"),
  "companies/delete": shopifyEvent("companies/delete"),
  "companies/update": shopifyEvent("companies/update"),
  "company_contact_roles/assign": shopifyEvent("company_contact_roles/assign"),
  "company_contact_roles/revoke": shopifyEvent("company_contact_roles/revoke"),
  "company_contacts/create": shopifyEvent("company_contacts/create"),
  "company_contacts/delete": shopifyEvent("company_contacts/delete"),
  "company_contacts/update": shopifyEvent("company_contacts/update"),
  "company_locations/create": shopifyEvent("company_locations/create"),
  "company_locations/delete": shopifyEvent("company_locations/delete"),
  "company_locations/update": shopifyEvent("company_locations/update"),
  "customer_groups/create": shopifyEvent("customer_groups/create"),
  "customer_groups/delete": shopifyEvent("customer_groups/delete"),
  "customer_groups/update": shopifyEvent("customer_groups/update"),
  "customer_payment_methods/create": shopifyEvent("customer_payment_methods/create"),
  "customer_payment_methods/revoke": shopifyEvent("customer_payment_methods/revoke"),
  "customer_payment_methods/update": shopifyEvent("customer_payment_methods/update"),
  "customers/create": shopifyEvent("customers/create"),
  "customers/delete": shopifyEvent("customers/delete"),
  "customers/disable": shopifyEvent("customers/disable"),
  "customers/enable": shopifyEvent("customers/enable"),
  "customers/merge": shopifyEvent("customers/merge"),
  "customers/update": shopifyEvent("customers/update"),
  "customers_email_marketing_consent/update": shopifyEvent(
    "customers_email_marketing_consent/update"
  ),
  "customers_marketing_consent/update": shopifyEvent("customers_marketing_consent/update"),
  "disputes/create": shopifyEvent("disputes/create"),
  "disputes/update": shopifyEvent("disputes/update"),
  "domains/create": shopifyEvent("domains/create"),
  "domains/destroy": shopifyEvent("domains/destroy"),
  "domains/update": shopifyEvent("domains/update"),
  "draft_orders/create": shopifyEvent("draft_orders/create"),
  "draft_orders/delete": shopifyEvent("draft_orders/delete"),
  "draft_orders/update": shopifyEvent("draft_orders/update"),
  "fulfillment_events/create": shopifyEvent("fulfillment_events/create"),
  "fulfillment_events/delete": shopifyEvent("fulfillment_events/delete"),
  "fulfillment_orders/cancellation_request_accepted": shopifyEvent(
    "fulfillment_orders/cancellation_request_accepted"
  ),
  "fulfillment_orders/cancellation_request_rejected": shopifyEvent(
    "fulfillment_orders/cancellation_request_rejected"
  ),
  "fulfillment_orders/cancellation_request_submitted": shopifyEvent(
    "fulfillment_orders/cancellation_request_submitted"
  ),
  "fulfillment_orders/cancelled": shopifyEvent("fulfillment_orders/cancelled"),
  "fulfillment_orders/fulfillment_request_accepted": shopifyEvent(
    "fulfillment_orders/fulfillment_request_accepted"
  ),
  "fulfillment_orders/fulfillment_request_rejected": shopifyEvent(
    "fulfillment_orders/fulfillment_request_rejected"
  ),
  "fulfillment_orders/fulfillment_request_submitted": shopifyEvent(
    "fulfillment_orders/fulfillment_request_submitted"
  ),
  "fulfillment_orders/fulfillment_service_failed_to_complete": shopifyEvent(
    "fulfillment_orders/fulfillment_service_failed_to_complete"
  ),
  "fulfillment_orders/hold_released": shopifyEvent("fulfillment_orders/hold_released"),
  "fulfillment_orders/line_items_prepared_for_local_delivery": shopifyEvent(
    "fulfillment_orders/line_items_prepared_for_local_delivery"
  ),
  "fulfillment_orders/line_items_prepared_for_pickup": shopifyEvent(
    "fulfillment_orders/line_items_prepared_for_pickup"
  ),
  "fulfillment_orders/moved": shopifyEvent("fulfillment_orders/moved"),
  "fulfillment_orders/order_routing_complete": shopifyEvent(
    "fulfillment_orders/order_routing_complete"
  ),
  "fulfillment_orders/placed_on_hold": shopifyEvent("fulfillment_orders/placed_on_hold"),
  "fulfillment_orders/rescheduled": shopifyEvent("fulfillment_orders/rescheduled"),
  "fulfillment_orders/scheduled_fulfillment_order_ready": shopifyEvent(
    "fulfillment_orders/scheduled_fulfillment_order_ready"
  ),
  "fulfillments/create": shopifyEvent("fulfillments/create"),
  "fulfillments/update": shopifyEvent("fulfillments/update"),
  "inventory_items/create": shopifyEvent("inventory_items/create"),
  "inventory_items/delete": shopifyEvent("inventory_items/delete"),
  "inventory_items/update": shopifyEvent("inventory_items/update"),
  "inventory_levels/connect": shopifyEvent("inventory_levels/connect"),
  "inventory_levels/disconnect": shopifyEvent("inventory_levels/disconnect"),
  "inventory_levels/update": shopifyEvent("inventory_levels/update"),
  "locales/create": shopifyEvent("locales/create"),
  "locales/update": shopifyEvent("locales/update"),
  "locations/activate": shopifyEvent("locations/activate"),
  "locations/create": shopifyEvent("locations/create"),
  "locations/deactivate": shopifyEvent("locations/deactivate"),
  "locations/delete": shopifyEvent("locations/delete"),
  "locations/update": shopifyEvent("locations/update"),
  "markets/create": shopifyEvent("markets/create"),
  "markets/delete": shopifyEvent("markets/delete"),
  "markets/update": shopifyEvent("markets/update"),
  "order_transactions/create": shopifyEvent("order_transactions/create"),
  "orders/cancelled": shopifyEvent("orders/cancelled"),
  "orders/create": shopifyEvent("orders/create"),
  "orders/delete": shopifyEvent("orders/delete"),
  "orders/edited": shopifyEvent("orders/edited"),
  "orders/fulfilled": shopifyEvent("orders/fulfilled"),
  "orders/paid": shopifyEvent("orders/paid"),
  "orders/partially_fulfilled": shopifyEvent("orders/partially_fulfilled"),
  "orders/updated": shopifyEvent("orders/updated"),
  "payment_schedules/due": shopifyEvent("payment_schedules/due"),
  "product_feeds/create": shopifyEvent("product_feeds/create"),
  "product_feeds/full_sync": shopifyEvent("product_feeds/full_sync"),
  "product_feeds/incremental_sync": shopifyEvent("product_feeds/incremental_sync"),
  "product_listings/add": shopifyEvent("product_listings/add"),
  "product_listings/remove": shopifyEvent("product_listings/remove"),
  "product_listings/update": shopifyEvent("product_listings/update"),
  "products/create": shopifyEvent("products/create"),
  "products/delete": shopifyEvent("products/delete"),
  "products/update": shopifyEvent("products/update"),
  "profiles/create": shopifyEvent("profiles/create"),
  "profiles/delete": shopifyEvent("profiles/delete"),
  "profiles/update": shopifyEvent("profiles/update"),
  "refunds/create": shopifyEvent("refunds/create"),
  "scheduled_product_listings/add": shopifyEvent("scheduled_product_listings/add"),
  "scheduled_product_listings/remove": shopifyEvent("scheduled_product_listings/remove"),
  "scheduled_product_listings/update": shopifyEvent("scheduled_product_listings/update"),
  "selling_plan_groups/create": shopifyEvent("selling_plan_groups/create"),
  "selling_plan_groups/delete": shopifyEvent("selling_plan_groups/delete"),
  "selling_plan_groups/update": shopifyEvent("selling_plan_groups/update"),
  "shop/update": shopifyEvent("shop/update"),
  "subscription_billing_attempts/challenged": shopifyEvent(
    "subscription_billing_attempts/challenged"
  ),
  "subscription_billing_attempts/failure": shopifyEvent("subscription_billing_attempts/failure"),
  "subscription_billing_attempts/success": shopifyEvent("subscription_billing_attempts/success"),
  "subscription_billing_cycle_edits/create": shopifyEvent(
    "subscription_billing_cycle_edits/create"
  ),
  "subscription_billing_cycle_edits/delete": shopifyEvent(
    "subscription_billing_cycle_edits/delete"
  ),
  "subscription_billing_cycle_edits/update": shopifyEvent(
    "subscription_billing_cycle_edits/update"
  ),
  "subscription_contracts/create": shopifyEvent("subscription_contracts/create"),
  "subscription_contracts/update": shopifyEvent("subscription_contracts/update"),
  "tender_transactions/create": shopifyEvent("tender_transactions/create"),
  "themes/create": shopifyEvent("themes/create"),
  "themes/delete": shopifyEvent("themes/delete"),
  "themes/publish": shopifyEvent("themes/publish"),
  "themes/update": shopifyEvent("themes/update"),
};

type WebhookCatalogOptions<
  TEvents extends Record<string, EventSpecification<any, any>>,
  TSource extends WebhookSource<any, any, any>,
> = {
  id: string;
  events: TEvents;
  source: TSource;
};

export class WebhookEventCatalog<
  TEvents extends Record<string, EventSpecification<any, any>>,
  TSource extends WebhookSource<any>,
> {
  constructor(private options: WebhookCatalogOptions<TEvents, TSource>) {}

  get events() {
    return this.options.events;
  }

  get source() {
    return this.options.source;
  }

  on<TName extends keyof TEvents, TParams extends GetWebhookParams<TSource>>(
    name: TName,
    params: TParams
  ): WebhookTrigger<TEvents[TName], TSource> {
    return new WebhookTrigger({
      event: this.events[name],
      params,
      source: this.source,
      config: {},
    });
  }
}

export function createWebhookEventCatalog(source: ReturnType<typeof createWebhookEventSource>) {
  return new WebhookEventCatalog({
    id: "shopify",
    events: shopifyEvents,
    source,
  });
}
