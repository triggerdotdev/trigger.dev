import type {
  ServiceMetadata,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { WhatsAppWebhookIntegration } from "./internal/webhooks";
import { WhatsAppRequestIntegration } from "./internal/requests";

const webhooks = new WhatsAppWebhookIntegration();
const requests = new WhatsAppRequestIntegration();

const metadata: ServiceMetadata = {
  name: "WhatsApp Business",
  service: "whatsapp",
  icon: "/integrations/whatsapp.png",
  live: true,
  authentication: {
    apiKey: {
      type: "api_key",
      placement: {
        in: "header",
        type: "bearer",
        key: "Authorization",
      },
      documentation: `You need to generate a "permanent access token".\n Follow the steps in the WhatsApp documentation [here](https://developers.facebook.com/docs/whatsapp/business-management-api/get-started#1--acquire-an-access-token-using-a-system-user-or-facebook-login).`,
      scopes: {},
    },
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  webhooks,
  requests,
};

export * as schemas from "./schemas";
