import { SlackRequestIntegration } from "./internal/requests";

export const requests = new SlackRequestIntegration();

export const metadata = {
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

export * as schemas from "./schemas";
