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

export const makeWebhook = (
  data: {
    baseUrl: string;
    spec: WebhookSpec;
    authentication: IntegrationAuthentication;
  },
  postSubscribe?: (
    result: WebhookSubscriptionResult
  ) => WebhookSubscriptionResult
) => {
  const subscribe = async (config: WebhookSubscriptionRequest) => {
    const { baseUrl, spec, authentication } = data;
    const result = await subscribeToWebhook({
      baseUrl,
      authentication,
      webhook: spec,
      credentials: config.credentials,
      callbackUrl: config.callbackUrl,
      events: config.events,
      secret: config.secret,
      data: config.data,
    });
    if (!postSubscribe) return result;
    return postSubscribe(result);
  };

  return {
    spec: data.spec,
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
      throw new Error("Manual webhooks shouldn't call subscribe");
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
          secret,
          status: response.status,
          headers: response.headers,
          data: response.body,
        };
      }

      return {
        success: false,
        error: response.body,
      };
    }
  }
}
