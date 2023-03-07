import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { requestEndpoint } from "core/request/requestEndpoint";
import { HTTPResponse } from "core/request/types";
import { JSONSchema } from "core/schemas/types";
import {
  Webhook,
  WebhookEvent,
  WebhookReceiveRequest,
  WebhookSpec,
  WebhookSubscription,
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
  subscription:
    | {
        type: "automatic";
        requiresSecret: boolean;
        inputSchema: JSONSchema | null;
        /** take the raw data and turn it into the appropriate input for the subscribe request */
        preSubscribe: (input: {
          webhookId: string;
          callbackUrl: string;
          events: string[];
          secret?: string;
          data: Record<string, any>;
        }) => { parameters?: Record<string, any>; body?: any };
        /** after a subscription you might want to alter the result, e.g. add secret from response */
        postSubscribe?: (
          result: WebhookSubscriptionResult
        ) => WebhookSubscriptionResult;
      }
    | {
        type: "manual";
        requiresSecret: boolean;
      };
  /** You can verify the payload, or if they do a subscription verification you can respond */
  preProcess?: (data: WebhookReceiveRequest) => Promise<
    | {
        success: true;
        processEvents: boolean;
        response: HTTPResponse;
      }
    | {
        success: false;
        error: string;
        processEvents: boolean;
        response: HTTPResponse;
      }
  >;
}): Webhook {
  const { baseUrl, spec, authentication } = input.data;

  let subscription: WebhookSubscription;
  switch (input.subscription.type) {
    case "automatic": {
      const subscribe = async (config: WebhookSubscriptionRequest) => {
        if (input.subscription.requiresSecret && !config.secret) {
          return {
            success: false as const,
            error: "Secret is required",
          };
        }

        if (!("preSubscribe" in input.subscription))
          throw new Error("No required presubscribe field");

        const subscribeInputData = input.subscription.preSubscribe({
          webhookId: config.webhookId,
          callbackUrl: config.callbackUrl,
          events: config.events,
          secret: config.secret,
          data: config.inputData,
        });

        const result = await subscribeToWebhook({
          id: config.webhookId,
          baseUrl,
          authentication,
          webhook: spec,
          credentials: config.credentials,
          callbackUrl: config.callbackUrl,
          events: config.events,
          secret: config.secret,
          data: config.inputData,
          subscribeInputData,
        });
        //have to do this because TS is dumb because this in a closure
        if (!("postSubscribe" in input.subscription)) return result;

        if (!input.subscription.postSubscribe) return result;
        return input.subscription.postSubscribe(result);
      };

      subscription = {
        type: "automatic",
        inputSchema: input.subscription.inputSchema,
        requiresSecret: input.subscription.requiresSecret,
        subscribe: subscribe,
      };
      break;
    }
    case "manual": {
      subscription = {
        type: "manual",
        requiresSecret: input.subscription.requiresSecret,
      };
      break;
    }
  }

  const receive = async (receiveRequest: WebhookReceiveRequest) => {
    //verification and early response can happen here
    const preEventResult = await input.preProcess?.(receiveRequest);
    let response: HTTPResponse | undefined = undefined;
    if (preEventResult) {
      //fail so we return an error
      if (!preEventResult.success) {
        return {
          success: false as const,
          error: preEventResult.error,
          response: preEventResult.response,
        };
      }

      //we don't want to process any events
      if (!preEventResult.processEvents) {
        return {
          success: true as const,
          eventResults: [],
          response: preEventResult.response,
        };
      }

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

    const promises = matchingEvents.map((event) =>
      event.process(receiveRequest)
    );

    const results = await Promise.all(promises);

    return {
      success: true as const,
      eventResults: results.flat(),
      response,
    };
  };

  return {
    baseUrl: baseUrl,
    spec: spec,
    authentication: authentication,
    events: input.events,
    subscription,
    receive,
  };
}

async function subscribeToWebhook({
  id,
  baseUrl,
  authentication,
  webhook,
  credentials,
  callbackUrl,
  events,
  secret,
  data,
  subscribeInputData,
}: {
  id: string;
  baseUrl: string;
  authentication: IntegrationAuthentication;
  webhook: WebhookSpec;
  credentials?: AuthCredentials;
  callbackUrl: string;
  events: string[];
  secret?: string;
  data: Record<string, any>;
  subscribeInputData: {
    parameters?: Record<string, any> | undefined;
    body?: any;
  };
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
          parameters: subscribeInputData.parameters,
          body: subscribeInputData.body,
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
