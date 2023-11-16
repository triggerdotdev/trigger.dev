import { DisplayProperty, EventSpecification, EventSpecificationExample } from "@trigger.dev/sdk";
import { DeletedPayload, ShopLocale } from "./schemas";
import { getBasicProperties } from "./utils";
import * as eg from "./payload-examples";
import { ShopifyWebhookPayload } from "./types";

const eventSpec = <TEvent>({
  name,
  title,
  examples,
  runProperties,
}: {
  name: string;
  title: string;
  examples?: EventSpecificationExample[];
  runProperties?: (payload: TEvent) => DisplayProperty[];
}): EventSpecification<TEvent> => {
  return {
    name,
    title,
    source: "shopify.com",
    icon: "shopify",
    examples,
    parsePayload: (payload) => payload as TEvent,
    runProperties,
  };
};

export const onFulfillmentCreated = eventSpec<ShopifyWebhookPayload["Fulfillment"]>({
  name: "fulfillments/create",
  title: "On Fulfillment Created",
  examples: [eg.fulfillmentCreated],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onFulfillmentUpdated = eventSpec<ShopifyWebhookPayload["Fulfillment"]>({
  name: "fulfillments/update",
  title: "On Fulfillment Updated",
  examples: [eg.fulfillmentUpdated],
  runProperties: (payload) => getBasicProperties(payload),
});

export const onInventoryItemCreated = eventSpec<ShopifyWebhookPayload["InventoryItem"]>({
  name: "inventory_items/create",
  title: "On InventoryItem Created",
  examples: [eg.inventoryItemCreated],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onInventoryItemDeleted = eventSpec<DeletedPayload>({
  name: "inventory_items/delete",
  title: "On InventoryItem Deleted",
  examples: [eg.inventoryItemDeleted],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onInventoryItemUpdated = eventSpec<ShopifyWebhookPayload["InventoryItem"]>({
  name: "inventory_items/update",
  title: "On InventoryItem Updated",
  examples: [eg.inventoryItemUpdated],
  runProperties: (payload) => getBasicProperties(payload),
});

export const onInventoryLevelConnected = eventSpec<ShopifyWebhookPayload["InventoryLevel"]>({
  name: "inventory_levels/connect",
  title: "On InventoryLevel Connected",
  examples: [eg.inventoryLevelConnected],
});
export const onInventoryLevelDisconnected = eventSpec<ShopifyWebhookPayload["InventoryLevel"]>({
  name: "inventory_levels/delete",
  title: "On InventoryLevel Disconnected",
  examples: [eg.inventoryLevelDisconnected],
});
export const onInventoryLevelUpdated = eventSpec<ShopifyWebhookPayload["InventoryLevel"]>({
  name: "inventory_levels/update",
  title: "On InventoryLevel Updated",
  examples: [eg.inventoryLevelUpdated],
});

export const onLocaleCreated = eventSpec<ShopLocale>({
  name: "locales/create",
  title: "On Locale Created",
  examples: [eg.localeCreated],
});
export const onLocaleUpdated = eventSpec<ShopLocale>({
  name: "locales/update",
  title: "On Locale Updated",
  examples: [eg.localeUpdated],
});

export const onLocationActivated = eventSpec<ShopifyWebhookPayload["Location"]>({
  name: "locations/activate",
  title: "On Location Activated",
  examples: [eg.locationActivated],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onLocationCreated = eventSpec<ShopifyWebhookPayload["Location"]>({
  name: "locations/create",
  title: "On Location Created",
  examples: [eg.locationCreated],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onLocationDeactivated = eventSpec<ShopifyWebhookPayload["Location"]>({
  name: "locations/deactivate",
  title: "On Location Deactivated",
  examples: [eg.locationDeactivated],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onLocationDeleted = eventSpec<ShopifyWebhookPayload["Location"]>({
  name: "locations/delete",
  title: "On Location Deleted",
  examples: [eg.locationDeleted],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onLocationUpdated = eventSpec<ShopifyWebhookPayload["Location"]>({
  name: "locations/update",
  title: "On Location Updated",
  examples: [eg.locationUpdated],
  runProperties: (payload) => getBasicProperties(payload),
});

export const onProductCreated = eventSpec<ShopifyWebhookPayload["Product"]>({
  name: "products/create",
  title: "On Product Created",
  examples: [eg.productCreated],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onProductDeleted = eventSpec<DeletedPayload>({
  name: "products/delete",
  title: "On Product Deleted",
  examples: [eg.productDeleted],
  runProperties: (payload) => getBasicProperties(payload),
});
export const onProductUpdated = eventSpec<ShopifyWebhookPayload["Product"]>({
  name: "products/update",
  title: "On Product Updated",
  examples: [eg.productUpdated],
  runProperties: (payload) => getBasicProperties(payload),
});
