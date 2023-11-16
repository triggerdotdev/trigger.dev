import { z } from "zod";
import * as events from "./events";
import { WebhookTopic } from "./schemas";
import { EventSpecification } from "@trigger.dev/sdk";
import { TriggerParams } from "./webhooks";
import { entries, fromEntries } from "@trigger.dev/integration-kit/utils";
import { Shopify } from ".";

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
  "products/create": events.onProductCreated,
  "products/delete": events.onProductDeleted,
  "products/update": events.onProductUpdated,
};

export const triggerCatalog: TriggerCatalog<WebhookTopic> = fromEntries(
  entries(topicCatalog).map(([topic, eventSpec]) => {
    return [topic, catalogEntry(topic, eventSpec)];
  })
);
