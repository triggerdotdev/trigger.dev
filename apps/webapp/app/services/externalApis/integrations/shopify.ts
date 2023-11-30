import type { HelpSample, Integration } from "../types";

function usageSample(hasApiKey: boolean): HelpSample {
  const apiKeyPropertyName = "apiKey";

  return {
    title: "Using the client",
    code: `
import { Shopify } from "@trigger.dev/shopify";

const shopify = new Shopify({
  id: "__SLUG__",${hasApiKey ? `\n  ${apiKeyPropertyName}: process.env.SHOPIFY_API_KEY!,` : ""}
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY!,
  adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!,
  hostName: process.env.SHOPIFY_SHOP_DOMAIN!,
});

client.defineJob({
  id: "shopify-create-product",
  name: "Shopify: Create Product",
  version: "0.1.0",
  integrations: { shopify },
  trigger: eventTrigger({
    name: "shopify.product.create",
    schema: z.object({
      title: z.string(),
    }),
  }),
  run: async (payload, io, ctx) => {
    const product = await io.shopify.rest.Product.save("create-product", {
      fromData: {
        title: payload.title,
      },
    });

    await io.logger.info(\`Created product \${product.id}: \${product.title}\`);
  },
});
  `,
  };
}

export const shopify: Integration = {
  identifier: "shopify",
  name: "Shopify",
  packageName: "@trigger.dev/shopify@latest",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [usageSample(true)],
      },
    },
  },
};
