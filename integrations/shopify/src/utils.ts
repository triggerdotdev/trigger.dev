import { Base } from "@shopify/shopify-api/rest/base";
import { RecursiveShopifySerializer } from "./types";
import { WebhookTopic } from "./schemas";
import { DisplayProperty, EventSpecificationExample } from "@trigger.dev/sdk";
import { EventSpecification } from "@trigger.dev/sdk";
import { titleCase } from "@trigger.dev/integration-kit";

export const basicProperties = (payload: { id: string | number }) => {
  return [{ label: "ID", text: String(payload.id) }];
};

export const serializeShopifyResource = <TResource extends Base | Base[] | null>(
  resource: TResource
): RecursiveShopifySerializer<TResource> => {
  return JSON.parse(JSON.stringify(resource));
};

const topicToTitle = (topic: WebhookTopic) => {
  const prettyTopic = titleCase(topic.replace("_", " ").replace("/", " "));
  return `On ${prettyTopic}`;
};

export const eventSpec = <TEvent>({
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
