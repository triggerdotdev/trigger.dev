import { TriggerClient } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { Shopify } from "@trigger.dev/shopify";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const shopify = new Shopify({
  id: "shopify",
  adminAccessToken: process.env["SHOPIFY_ADMIN_ACCESS_TOKEN"]!,
  apiKey: process.env["SHOPIFY_API_KEY"],
  apiSecretKey: process.env["SHOPIFY_API_SECRET_KEY"]!,
  hostName: process.env["SHOPIFY_SHOP_DOMAIN"]!,
  scopes: ["read_products"],
});

// const shopify = new Shopify({
//   id: "shopify-oauth",
// });

client.defineJob({
  id: "shopify-on-product-created",
  name: "Shopify Example: onProductCreated",
  version: "0.1.0",
  trigger: shopify.onProductCreated(),
  run: async (payload, io, ctx) => {
    await io.logger.log(`product created: ${payload.id}`);
  },
});

client.defineJob({
  id: "shopify-on-product-deleted",
  name: "Shopify Example: onProductDeleted",
  version: "0.1.0",
  trigger: shopify.onProductDeleted(),
  run: async (payload, io, ctx) => {
    await io.logger.log(`product deleted: ${payload.id}`);
  },
});

createExpressServer(client);
