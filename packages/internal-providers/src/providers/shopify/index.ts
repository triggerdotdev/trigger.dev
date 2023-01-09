// import * as schemas from "./schemas";

export const shopify = {
  name: "Shopify",
  slug: "shopify",
  icon: "/integrations/shopify.png",
  enabledFor: "admins",
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
    documentation: `Name this integration and create a \`Personal access token\`. <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>
      Here is some more text <br>`,
  },
  schemas: {},
};
