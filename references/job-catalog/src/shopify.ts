import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";

import "@shopify/shopify-api/adapters/node";
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
  apiKey: process.env["SHOPIFY_API_KEY"]!,
  apiSecretKey: process.env["SHOPIFY_API_SECRET_KEY"]!,
  hostName: process.env["SHOPIFY_SHOP_DOMAIN"]!,
});

// const shopify = new Shopify({
//   id: "shopify-oauth",
// });

client.defineJob({
  id: "shopify-products-create",
  name: "Shopify: products/create",
  version: "0.1.0",
  trigger: shopify.on("products/create"),
  run: async (payload, io, ctx) => {
    await io.logger.log(`product created: ${payload.id}`);
  },
});

client.defineJob({
  id: "shopify-products-delete",
  name: "Shopify: products/delete",
  version: "0.1.0",
  trigger: shopify.on("products/delete"),
  run: async (payload, io, ctx) => {
    await io.logger.log(`product deleted: ${payload.id}`);
  },
});

client.defineJob({
  id: "shopify-task-examples",
  name: "Shopify: Task Examples",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "shopify.task.examples",
  }),
  integrations: {
    shopify,
  },
  run: async (payload, io, ctx) => {
    await io.shopify.rest.Product.count("count-products");

    const createdProduct = await io.shopify.rest.Product.save("create-product", {
      fromData: {
        title: "Some Product",
      },
    });

    await io.logger.info(`Created product ${createdProduct.id}: ${createdProduct.title}`);

    await io.shopify.rest.Product.count("count-products-again");

    const foundProduct = await io.shopify.rest.Product.find("find-product", {
      id: createdProduct.id,
    });

    if (foundProduct) {
      await io.shopify.rest.Variant.all("get-all-variants", {
        product_id: foundProduct.id,
      });

      await io.shopify.rest.Product.delete("delete-product", {
        id: foundProduct.id,
      });
    }

    const allProducts = await io.shopify.rest.Product.all("get-all-products", {
      limit: 2,
      autoPaginate: true,
    });

    if (allProducts.data.length) {
      const firstProduct = allProducts.data[0];

      await io.shopify.rest.Product.delete("delete-first", {
        id: firstProduct.id,
      });
    }
  },
});

createExpressServer(client);
