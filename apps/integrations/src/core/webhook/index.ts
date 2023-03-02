import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { requestEndpoint } from "core/request/requestEndpoint";
import { HTTPResponse } from "core/request/types";
import {
  Webhook,
  WebhookEvent,
  WebhookReceiveRequest,
  WebhookSpec,
  WebhookSubscriptionRequest,
  WebhookSubscriptionResult,
} from "./types";

export function makeWebhook(input: {
  data: {
    baseUrl: string;
    spec: WebhookSpec;
    authentication: IntegrationAuthentication;
  };
  /** the events that belong to this webhook */
  events: WebhookEvent[];
  /** after a subscription you might want to alter the result, e.g. add secret from response */
  postSubscribe?: (
    result: WebhookSubscriptionResult
  ) => WebhookSubscriptionResult;
  /** You can verify the payload, or if they do a subscription verification you can respond */
  preEvent?: (data: WebhookReceiveRequest) => Promise<{
    processEvents: boolean;
    response: HTTPResponse;
  }>;
}): Webhook {
  const { baseUrl, spec, authentication } = input.data;

  const subscribe = async (config: WebhookSubscriptionRequest) => {
    const result = await subscribeToWebhook({
      baseUrl,
      authentication,
      webhook: spec,
      credentials: config.credentials,
      callbackUrl: config.callbackUrl,
      events: config.events,
      secret: config.secret,
      data: config.inputData,
    });
    if (!input.postSubscribe) return result;
    return input.postSubscribe(result);
  };

  const receive = async (receiveRequest: WebhookReceiveRequest) => {
    //verification and early response can happen here
    const preEventResult = await input.preEvent?.(receiveRequest);
    let response: HTTPResponse | undefined = undefined;
    if (preEventResult) {
      if (!preEventResult.processEvents) return preEventResult;
      response = preEventResult.response;
    }

    if (!response) {
      response = {
        status: 200,
        headers: {},
      };
    }

    const matchingEvents = input.events.filter((event) =>
      event.matches({
        subscriptionData: receiveRequest.subscriptionData,
        request: receiveRequest.request,
      })
    );

    //todo process relevant events

    const promises = matchingEvents.map((event) =>
      event.process(receiveRequest)
    );

    const results = await Promise.all(promises);

    return {
      response,
      eventResults: results.flat(),
    };
  };

  return {
    baseUrl: baseUrl,
    spec: spec,
    authentication: authentication,
    events: input.events,
    subscribe,
    receive,
  };
}

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
