import { IntegrationAuthentication } from "core/authentication/types";

export const authentication: IntegrationAuthentication = {
  api_key: {
    type: "api_key",
    placement: {
      in: "header",
      type: "bearer",
      key: "Authorization",
    },
    documentation: `1. Go to <a href="https://www.notion.so/my-integrations" target="_blank">the Notion integrations page</a> (this opens in a new window).
2. Click "New integration".
3. Enter a name for your integration and grant it permissions. If you wish to use all the actions you will need to grant it all permissions.
4. Click "Submit".
5. Copy the "Internal integration token" and paste it into the "API Key" field below.`,
    scopes: {},
  },
};
