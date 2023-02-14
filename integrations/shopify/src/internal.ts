import type {
  ServiceMetadata,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { ShopifyRequestIntegration } from "./internal/requests";

const requests = new ShopifyRequestIntegration();

const metadata: ServiceMetadata = {
  name: "Shopify",
  service: "shopify",
  icon: "/integrations/shopify.png",
  live: true,
  authentication: {
    apikey: {
      type: "api_key",
      placement: {
        in: "header",
        type: "bearer",
        key: "X-Shopify-Access-Token",
      },
      additionalFields: [
        {
          key: "store_name",
          fieldType: "text",
          name: "Store name",
          placeholder: "mystore",
          description: `This is the name of your Shopify store`,
        },
      ],
      documentation: `1. Follow [this guide](https://help.shopify.com/en/manual/apps/custom-apps) to enable Custom apps`,
    },
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  requests,
};

export * as schemas from "./schemas";
