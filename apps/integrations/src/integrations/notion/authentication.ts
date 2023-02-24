import { IntegrationAuthentication } from "core/authentication/types";

export const authentication: IntegrationAuthentication = {
  oauth: {
    type: "oauth2",
    placement: {
      in: "header",
      type: "bearer",
      key: "Authorization",
    },
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    flow: "accessCode",
    scopes: {},
  },
};
