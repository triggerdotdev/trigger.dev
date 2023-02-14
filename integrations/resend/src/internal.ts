import type {
  ServiceMetadata,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { ResendRequestIntegration } from "./internal/requests";

const requests = new ResendRequestIntegration();

const metadata: ServiceMetadata = {
  name: "Resend",
  service: "resend",
  icon: "/integrations/resend.png",
  live: true,
  authentication: {
    apiKey: {
      type: "api_key",
      placement: {
        in: "header",
        type: "bearer",
        key: "Authorization",
      },
      documentation: `1. Login to [Resend](https://resend.com)
    2. Go to the API Keys page
    3. Generate a new API key
    4. Paste it into the field below`,
    },
  },
};

export const internalIntegration: InternalIntegration = {
  metadata,
  requests,
};

export * as schemas from "./schemas";
