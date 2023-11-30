import { Nullable, Prettify } from "@trigger.dev/integration-kit";
import { basicProperties, eventSpec } from "./utils";
import { ShopifyExamples, ShopifyPayloads, shopifyExample } from "./payload-examples";

type ShopifyThis<TResource> = Prettify<
  Nullable<TResource> & {
    [key: string]: any;
  }
>;

export const shopifyEvent = <TTopic extends Parameters<ShopifyExamples>[0]>(topic: TTopic) => {
  return eventSpec<ShopifyThis<ShopifyPayloads[TTopic]>>({
    topic,
    examples: [shopifyExample(topic)],
    runProperties: (payload) => basicProperties(payload),
  });
};
