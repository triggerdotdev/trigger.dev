import { IntegrationAuthentication } from "core/authentication/types";

export const authentication: IntegrationAuthentication = {
  oauth: {
    type: "oauth2",
    placement: {
      in: "header",
      type: "bearer",
      key: "Authorization",
    },
    authorizationUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    flow: "accessCode",
    scopes: {
      "data.records:read": "data.records:read",
      "data.records:write": "data.records:write",
      "data.recordComments:read": "data.recordComments:read",
      "data.recordComments:write": "data.recordComments:write",
      "schema.bases:read": "schema.bases:read",
      "schema.bases:write": "schema.bases:write",
      "webhook:manage": "webhook:manage",
    },
  },
};
