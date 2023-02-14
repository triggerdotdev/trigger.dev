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
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: ["repo"],
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  webhooks,
};

export * as schemas from "./schemas";
