import type {
  ServiceMetadata,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { GitHubWebhookIntegration } from "./internal/webhooks";

const webhooks = new GitHubWebhookIntegration();

const metadata: ServiceMetadata = {
  name: "GitHub",
  service: "github",
  icon: "/integrations/github.png",
  live: true,
  authentication: {
    oauth: {
      type: "oauth2",
      placement: {
        in: "header",
        type: "bearer",
        key: "Authorization",
      },
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      flow: "accessCode",
      scopes: { repo: "repo" },
    },
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  webhooks,
};

export * as schemas from "./schemas";
