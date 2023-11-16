import { z } from "zod";

export const ApiVersionSchema = z.enum([
  "2022-10",
  "2023-01",
  "2023-04",
  "2023-07",
  "2023-10",
  "unstable",
]);

export const ApiScopeSchema = z.enum([
  "read_all_orders",
  "read_assigned_fulfillment_orders",
  "write_assigned_fulfillment_orders",
  "read_cart_transforms",
  "write_cart_transforms",
  "read_checkouts",
  "write_checkouts",
  "read_checkout_branding_settings",
  "write_checkout_branding_settings",
  "read_content",
  "write_content",
  "read_customer_merge",
  "write_customer_merge",
  "read_customers",
  "write_customers",
  "read_customer_payment_methods",
  "read_discounts",
  "write_discounts",
  "read_draft_orders",
  "write_draft_orders",
  "read_files",
  "write_files",
  "read_fulfillments",
  "write_fulfillments",
  "read_gift_cards",
  "write_gift_cards",
  "read_inventory",
  "write_inventory",
  "read_legal_policies",
  "read_locales",
  "write_locales",
  "read_locations",
  "read_markets",
  "write_markets",
  "read_metaobject_definitions",
  "write_metaobject_definitions",
  "read_metaobjects",
  "write_metaobjects",
  "read_marketing_events",
  "write_marketing_events",
  "read_merchant_approval_signals",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "read_orders",
  "write_orders",
  "read_payment_mandate",
  "write_payment_mandate",
  "read_payment_terms",
  "write_payment_terms",
  "read_price_rules",
  "write_price_rules",
  "read_products",
  "write_products",
  "read_product_listings",
  "read_publications",
  "write_publications",
  "read_purchase_options",
  "write_purchase_options",
  "read_reports",
  "write_reports",
  "read_resource_feedbacks",
  "write_resource_feedbacks",
  "read_script_tags",
  "write_script_tags",
  "read_shipping",
  "write_shipping",
  "read_shopify_payments_disputes",
  "read_shopify_payments_payouts",
  "read_own_subscription_contracts",
  "write_own_subscription_contracts",
  "read_returns",
  "write_returns",
  "read_themes",
  "write_themes",
  "read_translations",
  "write_translations",
  "read_third_party_fulfillment_orders",
  "write_third_party_fulfillment_orders",
  "read_users",
  "read_order_edits",
  "write_order_edits",
  "write_payment_gateways",
  "write_payment_sessions",
  "write_pixels",
  "read_customer_events",
]);

export type ApiScope = z.infer<typeof ApiScopeSchema>;

export const WebhookTopicSchema = z.enum([
  // "app/uninstalled",
  // "app_subscriptions/update",
  // "bulk_operations/finish",
  // "carts/create",
  // "carts/update",
  // "checkouts/create",
  // "checkouts/delete",
  // "checkouts/update",
  // "collection_listings/add",
  // "collection_listings/remove",
  // "collection_listings/update",
  // "collections/create",
  // "collections/delete",
  // "collections/update",
  // "companies/create",
  // "companies/delete",
  // "companies/update",
  // "company_contact_roles/assign",
  // "company_contact_roles/revoke",
  // "company_contacts/create",
  // "company_contacts/delete",
  // "company_contacts/update",
  // "company_locations/create",
  // "company_locations/delete",
  // "company_locations/update",
  // "customer_groups/create",
  // "customer_groups/delete",
  // "customer_groups/update",
  // "customer_payment_methods/create",
  // "customer_payment_methods/revoke",
  // "customer_payment_methods/update",
  // "customers/create",
  // "customers/delete",
  // "customers/disable",
  // "customers/enable",
  // "customers/merge",
  // "customers/update",
  // "customers_email_marketing_consent/update",
  // "customers_marketing_consent/update",
  // "disputes/create",
  // "disputes/update",
  // "domains/create",
  // "domains/destroy",
  // "domains/update",
  // "draft_orders/create",
  // "draft_orders/delete",
  // "draft_orders/update",
  // "fulfillment_events/create",
  // "fulfillment_events/delete",
  // "fulfillment_orders/cancellation_request_accepted",
  // "fulfillment_orders/cancellation_request_rejected",
  // "fulfillment_orders/cancellation_request_submitted",
  // "fulfillment_orders/cancelled",
  // "fulfillment_orders/fulfillment_request_accepted",
  // "fulfillment_orders/fulfillment_request_rejected",
  // "fulfillment_orders/fulfillment_request_submitted",
  // "fulfillment_orders/fulfillment_service_failed_to_complete",
  // "fulfillment_orders/hold_released",
  // "fulfillment_orders/line_items_prepared_for_local_delivery",
  // "fulfillment_orders/line_items_prepared_for_pickup",
  // "fulfillment_orders/moved",
  // "fulfillment_orders/order_routing_complete",
  // "fulfillment_orders/placed_on_hold",
  // "fulfillment_orders/rescheduled",
  // "fulfillment_orders/scheduled_fulfillment_order_ready",
  "fulfillments/create",
  "fulfillments/update",
  "inventory_items/create",
  "inventory_items/delete",
  "inventory_items/update",
  "inventory_levels/connect",
  "inventory_levels/disconnect",
  "inventory_levels/update",
  "locales/create",
  "locales/update",
  "locations/activate",
  "locations/create",
  "locations/deactivate",
  "locations/delete",
  "locations/update",
  // "markets/create",
  // "markets/delete",
  // "markets/update",
  // "order_transactions/create",
  // "orders/cancelled",
  // "orders/create",
  // "orders/delete",
  // "orders/edited",
  // "orders/fulfilled",
  // "orders/paid",
  // "orders/partially_fulfilled",
  // "orders/updated",
  // "payment_schedules/due",
  // "product_feeds/create",
  // "product_feeds/full_sync",
  // "product_feeds/incremental_sync",
  // "product_listings/add",
  // "product_listings/remove",
  // "product_listings/update",
  "products/create",
  "products/delete",
  "products/update",
  // "profiles/create",
  // "profiles/delete",
  // "profiles/update",
  // "refunds/create",
  // "scheduled_product_listings/add",
  // "scheduled_product_listings/remove",
  // "scheduled_product_listings/update",
  // "selling_plan_groups/create",
  // "selling_plan_groups/delete",
  // "selling_plan_groups/update",
  // "shop/update",
  // "subscription_billing_attempts/challenged",
  // "subscription_billing_attempts/failure",
  // "subscription_billing_attempts/success",
  // "subscription_billing_cycle_edits/create",
  // "subscription_billing_cycle_edits/delete",
  // "subscription_billing_cycle_edits/update",
  // "subscription_contracts/create",
  // "subscription_contracts/update",
  // "tender_transactions/create",
  // "themes/create",
  // "themes/delete",
  // "themes/publish",
  // "themes/update",
]);

export type WebhookTopic = z.infer<typeof WebhookTopicSchema>;

export const WebhookHeaderSchema = z.object({
  "x-shopify-topic": WebhookTopicSchema,
  "x-shopify-product-id": z.coerce.number(),
  "x-shopify-webhook-id": z.string(),
  "x-shopify-api-version": ApiVersionSchema,
  "x-shopify-hmac-sha256": z.string(),
  "x-shopify-shop-domain": z.string(),
  "x-shopify-triggered-at": z.coerce.date(),
});

export const WebhookSubscriptionSchema = z.object({
  address: z.string(),
  api_version: ApiVersionSchema,
  created_at: z.coerce.date(),
  fields: z.string().array(),
  format: z.enum(["json", "xml"]),
  id: z.number(),
  metafield_namespaces: z.string().array(),
  private_metafield_namespaces: z.string().array(),
  topic: WebhookTopicSchema,
  updated_at: z.coerce.date(),
});

export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;

export const WebhookSubscriptionDataSchema = z.object({
  webhook: WebhookSubscriptionSchema,
});

export type WebhookSubscriptionData = z.infer<typeof WebhookSubscriptionDataSchema>;

export const FulfillmentSchema = z.object({
  created_at: z.coerce.date(),
  id: z.number(),
  line_items: z
    .object({
      id: z.number(),
      variant_id: z.number(),
      title: z.string(),
      quantity: z.number(),
      price: z.string(),
      grams: z.number(),
      sku: z.string(),
      variant_title: z.string(),
      vendor: z.any().nullable(),
      fulfillment_service: z.string(),
      product_id: z.number(),
      requires_shipping: z.boolean(),
      taxable: z.boolean(),
      gift_card: z.boolean(),
      name: z.string(),
      variant_inventory_management: z.string(),
      properties: z.array(z.any()),
      product_exists: z.boolean(),
      fulfillable_quantity: z.number(),
      total_discount: z.string(),
      fulfillment_status: z.any().nullable(),
      fulfillment_line_item_id: z.number(),
      tax_lines: z.array(z.any()),
      duties: z
        .object({
          id: z.string(),
          harmonized_system_code: z.string(),
          country_code_of_origin: z.string(),
          shop_money: z.object({
            amount: z.string(),
            currency_code: z.string(),
          }),
          presentment_money: z.object({
            amount: z.string(),
            currency_code: z.string(),
          }),
          tax_lines: z
            .object({
              title: z.string(),
              price: z.string(),
              rate: z.number(),
              price_set: z.object({
                shop_money: z.object({
                  amount: z.string(),
                  currency_code: z.string(),
                }),
                presentment_money: z.object({
                  amount: z.string(),
                  currency_code: z.string(),
                }),
              }),
            })
            .array(),
          admin_graphql_api_id: z.string(),
        })
        .array(),
    })
    .array(),
  location_id: z.number(),
  name: z.string(),
  notify_customer: z.boolean(),
  order_id: z.number(),
  origin_address: z
    .object({
      address1: z.string(),
      address2: z.string(),
      city: z.string(),
      country_code: z.string(),
      province_code: z.string(),
      zip: z.string(),
    })
    .array(),
  receipt: z.object({
    testcase: z.boolean(),
    authorization: z.string(),
  }),
  service: z.string(),
  shipment_status: z.string(),
  status: z.string(),
  tracking_company: z.string(),
  tracking_numbers: z.string().array(),
  tracking_number: z.string(),
  tracking_urls: z.string().array(),
  tracking_url: z.string(),
  updated_at: z.coerce.date(),
  variant_inventory_management: z.string(),
});

export type Fulfillment = z.infer<typeof FulfillmentSchema>;

export const InventoryItemSchema = z.object({
  cost: z.string(),
  country_code_of_origin: z.string(),
  country_harmonized_system_codes: z
    .object({
      harmonized_system_code: z.string(),
      country_code: z.string(),
    })
    .array(),
  created_at: z.coerce.date(),
  harmonized_system_code: z.number(),
  id: z.number(),
  province_code_of_origin: z.string(),
  sku: z.string(),
  tracked: z.boolean(),
  updated_at: z.coerce.date(),
  requires_shipping: z.boolean(),
});

export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const InventoryLevelSchema = z.object({
  available: z.number(),
  inventory_item_id: z.number(),
  location_id: z.number(),
  updated_at: z.coerce.date(),
});

export type InventoryLevel = z.infer<typeof InventoryLevelSchema>;

export const ShopLocaleSchema = z.object({
  locale: z.string(),
  published: z.boolean()
});

export type ShopLocale = z.infer<typeof ShopLocaleSchema>;

export const LocationSchema = z.object({
  active: z.boolean(),
  address1: z.string(),
  address2: z.string(),
  city: z.string(),
  country: z.string(),
  country_code: z.string(),
  created_at: z.coerce.date(),
  id: z.number(),
  legacy: z.boolean(),
  name: z.string(),
  phone: z.string(),
  province: z.string(),
  province_code: z.string(),
  updated_at: z.coerce.date(),
  zip: z.string(),
  localized_country_name: z.string(),
  localized_province_name: z.string(),
});

export type Location = z.infer<typeof LocationSchema>;

export const OrderSchema = z.object({}).passthrough();

export type Order = z.infer<typeof OrderSchema>;

export const ProductVariantSchema = z.object({
  barcode: z.string(),
  compare_at_price: z.string().nullable(),
  created_at: z.coerce.date(),
  fulfillment_service: z.string(),
  grams: z.number(),
  weight: z.number(),
  weight_unit: z.string(),
  id: z.number(),
  inventory_item_id: z.number(),
  inventory_management: z.string(),
  inventory_policy: z.string(),
  inventory_quantity: z.number(),
  option1: z.string(),
  position: z.number(),
  price: z.number(),
  product_id: z.number(),
  requires_shipping: z.boolean(),
  sku: z.string(),
  taxable: z.boolean(),
  title: z.string(),
  updated_at: z.coerce.date(),
});

export type ProductVariant = z.infer<typeof ProductVariantSchema>;

export const ProductImageSchema = z.object({
  id: z.number(),
  product_id: z.number(),
  position: z.number(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  width: z.number(),
  height: z.number(),
  src: z.string(),
  variant_ids: z.number().array(),
});

export type ProductImage = z.infer<typeof ProductImageSchema>;

export const ProductSchema = z.object({
  body_html: z.string(),
  created_at: z.coerce.date(),
  handle: z.string(),
  id: z.number(),
  images: ProductImageSchema.array(),
  options: z.object({
    id: z.number(),
    product_id: z.number(),
    name: z.string(),
    position: z.number(),
    values: z.string().array(),
  }),
  product_type: z.string(),
  published_at: z.coerce.date(),
  published_scope: z.string(),
  status: z.string(),
  tags: z.string(),
  template_suffix: z.string(),
  title: z.string(),
  updated_at: z.coerce.date(),
  variants: ProductVariantSchema.array(),
  vendor: z.string(),
});

export type Product = z.infer<typeof ProductSchema>;

export const DeletedPayloadSchema = z.object({
  id: z.number(),
});

export type DeletedPayload = z.infer<typeof DeletedPayloadSchema>;

// TODO: construct from other schemas
export const WebhookPayloadSchema = z.object({}).passthrough();
