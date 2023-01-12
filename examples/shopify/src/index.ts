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
          productId: ["gid://shopify/Product/8098295546157"],
          sku: ["variant-1"],
        },
      }
    );

    const newVariant = await shopify.createProductVariant("create-variant", {
      productId: results.productVariants[0].product.id,
      inventoryQuantities: [
        {
          availableQuantity: 10,
          locationId: "gid://shopify/Location/76187369773",
        },
      ],
      price: "12.34",
      sku: `variant-${Math.floor(Math.random() * 1000)}`,
      options: [pickRandom(sizes), pickRandom(materials)],
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
      title: `Fantastic product ${Math.floor(Math.random() * 1000)}`,
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

new Trigger({
  id: "shopify-create-product",
  name: "Shopify create product",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "shopify.create-product",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    const newProduct = await shopify.createProduct("create-product", {
      descriptionHtml: "This is my brilliant <i>product description</i>.",
      title: `Product for collection ${Math.floor(Math.random() * 1000)}`,
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

    await ctx.fireEvent("send-new-product-created", {
      name: "product.new",
      payload: { id: newProduct.id },
    });

    return newProduct;
  },
}).listen();

new Trigger({
  id: "shopify-add-product-to-collection",
  name: "Shopify add product to collection",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "product.new",
    schema: z.object({
      id: z.string(),
    }),
  }),
  run: async (event, ctx) => {
    const collection = await shopify.addProductsToCollection(
      "add-products-to-collection",
      {
        collectionId: "gid://shopify/Collection/431864578349",
        productIds: [event.id],
      }
    );

    return collection;
  },
}).listen();

new Trigger({
  id: "shopify-update-product",
  name: "Shopify update product",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "product.update",
    schema: z.object({
      id: z.string(),
    }),
  }),
  run: async (event, ctx) => {
    const product = await shopify.updateProduct("update-product", {
      id: event.id,
      descriptionHtml: `<h1>Awesome product title</h1><p>With incredible description</p>`,
    });

    return product;
  },
}).listen();
