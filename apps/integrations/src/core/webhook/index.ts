import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { requestEndpoint } from "core/request/requestEndpoint";
import {
  WebhookSpec,
  WebhookSubscriptionRequest,
  WebhookSubscriptionResult,
} from "./types";

export const makeWebhook = ({
  baseUrl,
  spec,
  authentication,
}: {
  baseUrl: string;
  spec: WebhookSpec;
  authentication: IntegrationAuthentication;
}) => {
  const subscribe = async (config: WebhookSubscriptionRequest) => {
    return await subscribeToWebhook({
      baseUrl,
      authentication,
      webhook: spec,
      credentials: config.credentials,
      callbackUrl: config.callbackUrl,
      events: config.events,
      secret: config.secret,
      data: config.data,
    });
  };

  return {
    spec,
    subscribe,
  };
};

async function subscribeToWebhook({
  baseUrl,
  authentication,
  webhook,
  credentials,
  callbackUrl,
  events,
  secret,
  data,
}: {
  baseUrl: string;
  authentication: IntegrationAuthentication;
  webhook: WebhookSpec;
  credentials?: AuthCredentials;
  callbackUrl: string;
  events: string[];
  secret?: string;
  data: Record<string, any>;
}): Promise<WebhookSubscriptionResult> {
  switch (webhook.subscribe.type) {
    case "manual":
      return {
        success: true,
        callbackUrl,
        events,
        data,
      };
    case "automatic": {
      const response = await requestEndpoint(
        {
          baseUrl,
          endpointSpec: webhook.subscribe.create,
          authentication,
        },
        {
          credentials,
          parameters: {
            callbackUrl,
            events,
            secret,
            ...data,
          },
        }
      );

      if (response.success) {
        return {
          success: true,
          callbackUrl,
          events,
          data,
        };
      }

      return {
        success: false,
        error: response.body,
      };
    }
  }
}
