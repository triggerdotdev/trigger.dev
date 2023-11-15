import { EventSpecification } from "@trigger.dev/sdk";
import { Product, ProductDeleted } from "./schemas";
import { onProductProperties } from "./utils";
import { productCreated, productDeleted, productUpdated } from "./payload-examples";

export const onProductCreated: EventSpecification<Product> = {
  name: "products/create",
  title: "On Product Created",
  source: "shopify.com",
  icon: "shopify",
  examples: [productCreated],
  parsePayload: (payload) => payload as Product,
  runProperties: (payload) => onProductProperties(payload),
};

export const onProductDeleted: EventSpecification<ProductDeleted> = {
  name: "products/delete",
  title: "On Product Deleted",
  source: "shopify.com",
  icon: "shopify",
  examples: [productDeleted],
  parsePayload: (payload) => payload as ProductDeleted,
  runProperties: (payload) => onProductProperties(payload),
};

export const onProductUpdated: EventSpecification<Product> = {
  name: "products/update",
  title: "On Product Updated",
  source: "shopify.com",
  icon: "shopify",
  examples: [productUpdated],
  parsePayload: (payload) => payload as Product,
  runProperties: (payload) => onProductProperties(payload),
};
