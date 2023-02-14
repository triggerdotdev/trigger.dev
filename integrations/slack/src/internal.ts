import type {
  ServiceMetadata,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { SlackRequestIntegration } from "./internal/requests";

const requests = new SlackRequestIntegration();

const metadata: ServiceMetadata = {
  name: "Slack",
  service: "slack",
  icon: "/integrations/slack.png",
  live: true,
  authentication: {
    slackAuth: {
      type: "oauth2",
      placement: {
        in: "header",
        type: "bearer",
        key: "Authorization",
      },
      authorizationUrl: "https://slack.com/oauth/authorize",
      tokenUrl: "https://slack.com/api/oauth.access",
      flow: "accessCode",
      scopes: {
        "channels:read": "channels:read",
        "channels:join": "channels:join",
        "channels:manage": "channels:manage",
        "chat:write": "chat:write",
        "groups:write": "groups:write",
        "im:write": "im:write",
        "mpim:write": "mpim:write",
        "chat:write.customize": "chat:write.customize",
        "reactions:write": "reactions:write",
      },
    },
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  requests,
};

export * as schemas from "./schemas";
