import * as schemas from "./schemas";

export const shopify = {
  name: "Shopify",
  slug: "shopify",
  icon: "/integrations/shopify.png",
  enabledFor: "all",
  authentication: {
    type: "api_key",
    header_name: "X-Shopify-Access-Token",
    header_type: "access_token",
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
  schemas,
};
