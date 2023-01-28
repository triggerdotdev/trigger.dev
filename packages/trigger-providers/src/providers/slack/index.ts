import * as schemas from "./schemas";

export const slack = {
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
    ],
  },
  schemas,
};
