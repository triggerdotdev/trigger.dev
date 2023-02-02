export function shopifyCreateNewProducts(apiKey: string) {
return `import { Trigger, customEvent } from "@trigger.dev/sdk";
import { z } from "zod";
import * as shopify from "@trigger.dev/shopify";

new Trigger({
  id: "shopify-products",
  name: "Shopify products",
  apiKey: "${apiKey}",
  on: customEvent({
    name: "shopify.products",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    const newProduct = await shopify.createProduct("create-product", {
      descriptionHtml: "This is my brilliant <i>product description</i>.",
      title: \`Fantastic product \${Math.floor(Math.random() * 1000)}\`,
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
`;
}