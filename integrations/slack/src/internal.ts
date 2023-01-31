import type {
  IntegrationMetadata,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { SlackRequestIntegration } from "./internal/requests";

const requests = new SlackRequestIntegration();

const metadata: IntegrationMetadata = {
  name: "Slack",
  slug: "slack",
  icon: "/integrations/slack.png",
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: [
      "channels:read",
      "channels:join",
      "channels:manage",
      "chat:write",
      "groups:write",
      "im:write",
      "mpim:write",
      "chat:write.customize",
      "reactions:write",
    ],
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  requests,
};

export * as schemas from "./schemas";
