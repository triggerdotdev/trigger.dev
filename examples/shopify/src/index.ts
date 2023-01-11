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

function pickRandom(array: string[]): string {
  return array[Math.floor(Math.random() * array.length)];
}

new Trigger({
  id: "shopify-product-variants",
  name: "Shopify product variants",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "shopify.product-variants",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Get Shopify products variants");

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
      inventoryQuantities: [
        {
          availableQuantity: 10,
          locationId: "gid://shopify/Location/76378800435",
        },
      ],
      price: "12.34",
      sku: `variant-${Math.floor(Math.random() * 1000)}`,
      options: [pickRandom(sizes), pickRandom(materials), pickRandom(colors)],
    });

    await ctx.logger.debug("Debug message");

    return newVariant;
  },
}).listen();

new Trigger({
  id: "shopify-products",
  name: "Shopify products",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "shopify.products",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    const newProduct = await shopify.createProduct("create-product", {
      descriptionHtml: "This is my brilliant <i>product description</i>.",
      title: "Fantastic product",
      productType: "t-shirt",
      vendor: "Nike",
      options: ["Color", "Size"],
      standardizedProductType: {
        productTaxonomyNodeId: "gid://shopify/ProductTaxonomyNode/352",
      },
      variants: [
        {
          price: "99.99",
          sku: "variant-1",
          inventoryItem: {
            tracked: true,
          },
          inventoryQuantities: [
            {
              availableQuantity: 1,
              locationId: "gid://shopify/Location/76187369773",
            },
          ],
          options: ["Maroon", "Tiny"],
        },
      ],
    });

    const newImages = await shopify.appendProductImages("append-images", {
      id: newProduct.id,
      images: [
        {
          src: "https://via.placeholder.com/600/92c952.png",
          altText: "Image 1",
        },
        {
          src: "https://via.placeholder.com/600/d32776.png",
          altText: "Image 2",
        },
      ],
    });

    return newProduct;
  },
}).listen();

new Trigger({
  id: "shopify-collections",
  name: "Shopify collections",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "shopify.collections",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    const collections = await shopify.listCollections("get-collections", {
      first: 10,
      filter: {
        title: ["Home page"],
      },
    });

    return collections;
  },
}).listen();

new Trigger({
  id: "shopify-locations",
  name: "Shopify locations",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "shopify.locations",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    const locations = await shopify.listLocations("get-locations", {
      first: 10,
    });

    return locations;
  },
}).listen();
