import * as schemas from "./schemas";

export const slack = {
  name: "Slack",
  slug: "slack",
  icon: "/integrations/slack.png",
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: ["channels:read", "channels:join", "chat:write"],
    environments: {
      development: {
        client_id: "276370297397.4579145654276",
      },
      production: {
        client_id: "276370297397.4639924595715",
      },
    },
  },
  schemas,
};
