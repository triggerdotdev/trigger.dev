import { IntegrationAuthentication } from "core/authentication/types";

export const authentication: IntegrationAuthentication = {
  accessToken: {
    type: "api_key",
    placement: {
      in: "header",
      type: "bearer",
      key: "Authorization",
    },
    documentation: `1. [Log in to the personal access token page](https://admin.typeform.com/user/tokens) at Typeform.
2. Click Generate a new token.
3. In the Token name field, type a name for the token to help you identify it.
4. Select the scopes you want, you will need the webhook ones if you wish to subscribe to events.
5. Click Generate token.
6. Copy the token and paste it into the field below.`,
    scopes: {
      "accounts:read": "accounts:read",
      "forms:write": "forms:write",
      "forms:read": "forms:read",
      "images:write": "images:write",
      "images:read": "images:read",
      "themes:write": "themes:write",
      "themes:read": "themes:read",
      "responses:read": "responses:read",
      "responses:write": "responses:write",
      "webhooks:read": "webhooks:read",
      "webhooks:write": "webhooks:write",
      "workspaces:read": "workspaces:read",
      "workspaces:write": "workspaces:write",
    },
  },
};
