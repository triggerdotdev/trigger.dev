import { GitHubWebhookIntegration } from "./webhooks";
import * as schemas from "./schemas";

export const provider = {
  name: "GitHub",
  slug: "github",
  icon: "/integrations/github.png",
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: ["repo"],
  },
  schemas,
};

export const webhooks = new GitHubWebhookIntegration();
