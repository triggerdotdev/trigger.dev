import { IntegrationAuthentication } from "core/authentication/types";

export const authentication: IntegrationAuthentication = {
  apiKey: {
    type: "api_key",
    placement: {
      in: "header",
      type: "bearer",
      key: "Authorization",
    },
    documentation: `1. [Log in to the API keys page](https://dashboard.stripe.com/apikeys) on Stripe.
2. Create a restricted API key with only the permissions you need.
3. Copy the token and paste it into the field below.`,
    scopes: {
      //todo needs filling out
      "webhooks:write": "webhooks:write",
    },
  },
};
