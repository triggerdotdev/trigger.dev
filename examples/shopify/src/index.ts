import { Trigger, customEvent } from "@trigger.dev/sdk";
import { z } from "zod";
import { shopify } from "@trigger.dev/integrations";

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

    const response = await shopify.searchProductVariants(
      "get-shopify-variants",
      {}
    );
    console.log(response);

    await ctx.logger.debug("Debug message");

    return response;
  },
});

trigger.listen();
