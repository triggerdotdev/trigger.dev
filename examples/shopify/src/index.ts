import { Trigger, customEvent } from "@trigger.dev/sdk";
import { z } from "zod";
import { shopify } from "@trigger.dev/integrations";

const sizes = ["Small", "Medium", "Large"];
const colors = [
  "Red",
  "Orange",
  "Yellow",
  "Green",
  "Blue",
  "Purple",
  "Pink",
  "Brown",
  "Black",
  "White",
  "Gray",
  "Silver",
  "Gold",
  "Beige",
];
const materials = ["Cotton", "Polyester", "Lycra", "Wool", "Silk", "Leather"];

const trigger = new Trigger({
  id: "get-shopify-products",
  name: "Get Shopify products",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "shopify.get",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Get Shopify products for my store");

    const results = await shopify.searchProductVariants(
      "get-shopify-variants",
      {
        filter: {
          productId: ["8066602598707"],
          sku: ["prod7", "prod8"],
        },
      }
    );

    const newVariant = await shopify.createProductVariant("create-variant", {
      productId: results.productVariants[0].product.id,
      options: [pickRandom(sizes), pickRandom(materials), pickRandom(colors)],
      price: "12.34",
    });

    await ctx.logger.debug("Debug message");

    return newVariant;
  },
});

trigger.listen();

function pickRandom(array: string[]): string {
  return array[Math.floor(Math.random() * array.length)];
}
