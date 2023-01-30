import { GitHubWebhookIntegration } from "./internal/webhooks";

export const webhooks = new GitHubWebhookIntegration();

export const metadata = {
  name: "GitHub",
  slug: "github",
  icon: "/integrations/github.png",
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: ["repo"],
  },
};

export * as schemas from "./schemas";
