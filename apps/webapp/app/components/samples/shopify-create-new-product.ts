export function shopifyCreateNewProducts(apiKey: string) {
  return `import { Trigger, customEvent } from "@trigger.dev/sdk";
import { z } from "zod";
import * as shopify from "@trigger.dev/shopify";

new Trigger({
  //todo: ensure this id is only used for this workflow
  id: "shopify-products",
  name: "Shopify products",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  //todo define the schema for the events you want to receive
  //this example accepts an empty JSON object: {}
  //you can use z.any() to accept any JSON, but you won't get nice types in the run function
  on: customEvent({
    name: "shopify.products",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    //this creates a new product in your Shopify store, with a variant
    const newProduct = await shopify.createProduct("create-product", {
      descriptionHtml: "This is my brilliant <i>product description</i>.",
      title: \`Fantastic product \${Math.floor(Math.random() * 1000)}\`,
      productType: "t-shirt",
      vendor: "Nike",
      options: ["Color", "Size"],
      standardizedProductType: {
        //you may need to update this to match your store's product taxonomy
        productTaxonomyNodeId: "gid://shopify/ProductTaxonomyNode/352",
      },
      variants: [
        {
          price: "99.99",
          sku: "variant-1",
          inventoryItem: {
            tracked: true,
          },
          options: ["Maroon", "Tiny"],
        },
      ],
    });

    //we add two images to the product
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
