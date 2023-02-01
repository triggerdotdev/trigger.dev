import type {
  IntegrationMetadata,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { WhatsAppWebhookIntegration } from "./internal/webhooks";
import { WhatsAppRequestIntegration } from "./internal/requests";

const webhooks = new WhatsAppWebhookIntegration();
const requests = new WhatsAppRequestIntegration();

const metadata: IntegrationMetadata = {
  name: "WhatsApp Business Account",
  slug: "whatsapp",
  icon: "/integrations/whatsapp.png",
  enabledFor: "admins",
  authentication: {
    type: "api_key",
    header_name: "Authorization",
    header_type: "access_token",
    documentation: `You need to generate a "permanent access token"\nFollow the steps in [this documentation](https://developers.facebook.com/docs/whatsapp/business-management-api/get-started#1--acquire-an-access-token-using-a-system-user-or-facebook-login).`,
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  webhooks,
  requests,
};

export * as schemas from "./schemas";
