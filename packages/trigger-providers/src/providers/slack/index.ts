import * as schemas from "./schemas";

export const slack = {
  name: "Slack",
  slug: "slack",
  icon: "/integrations/slack.png",
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: ["channels:read", "channels:join", "chat:write"],
  },
  schemas,
};
