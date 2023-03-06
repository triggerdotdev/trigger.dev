import type { IntegrationRequest } from ".prisma/client";
import type {
  AccessInfo,
  DisplayProperties,
  PerformedRequestResponse,
  ServiceMetadata,
} from "@trigger.dev/integration-sdk";
import { DisplayPropertiesSchema } from "@trigger.dev/integration-sdk";
import { z } from "zod";
import { env } from "~/env.server";

type ServiceSubscription = {
  service: string;
  type: "service";
  data: Record<string, any>;
  consumerId: string;
  callbackUrl: string;
  authentication:
    | {
        type: "oauth";
        connectionId: string;
      }
    | {
        type: "api-key";
        api_key: string;
      };
  eventName: string;
  key: string;
};

type GenericSubscription = {
  type: "generic";
  consumerId: string;
  callbackUrl: string;
  eventName: string;
  schema: any;
  verifyPayload: {
    enabled: boolean;
    header?: string;
  };
  key: string;
};

export type Subscription = ServiceSubscription | GenericSubscription;

const SubscriptionResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
  z.object({
    success: z.literal(true),
    destinationSecret: z.string(),
    displayProperties: DisplayPropertiesSchema,
    instructions: z.string(),
    examples: z.array(z.any()),
    result: z.union([
      z.object({
        type: z.literal("service"),
        webhookId: z.string(),
        subscription: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("automatic"),
          }),
          z.object({
            type: z.literal("manual"),
            url: z.string(),
            secret: z.string().optional(),
          }),
        ]),
      }),
      z.object({
        type: z.literal("generic"),
        webhookId: z.string(),
        url: z.string(),
        secret: z.string().optional(),
      }),
    ]),
  }),
]);

export type SubscribeResponse = z.infer<typeof SubscriptionResponseSchema>;

class IntegrationsClient {
  #baseUrl: string;
  #apiKey: string;
  constructor(apiOrigin: string, apiKey: string) {
    this.#baseUrl = `${apiOrigin}/api/v2`;
    this.#apiKey = apiKey;
  }

  async performRequest({
    service,
    accessInfo,
    integrationRequest,
    workflowId,
    connectionId,
  }: {
    service: string;
    accessInfo: AccessInfo;
    integrationRequest: IntegrationRequest;
    workflowId: string;
    connectionId: string;
  }): Promise<PerformedRequestResponse> {
    let credentials: { accessToken: string } | undefined = undefined;
    switch (accessInfo.type) {
      case "oauth2":
        credentials = {
          accessToken: accessInfo.accessToken,
        };
        break;
      case "api_key":
        credentials = {
          accessToken: accessInfo.api_key,
        };
    }

    try {
      const response = await fetch(
        `${this.#baseUrl}/${service}/action/${integrationRequest.endpoint}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.#apiKey}`,
          },
          body: JSON.stringify({
            credentials,
            params: integrationRequest.params,
            metadata: {
              requestId: integrationRequest.id,
              workflowId: workflowId,
              connectionId,
            },
          }),
        }
      );

      const json = await response.json();
      return json;
    } catch (e) {
      console.error(e);
      return {
        ok: false,
        isRetryable: true,
        response: {
          output: {
            error: {
              message: JSON.stringify(e),
            },
          },
          context: {},
        },
      };
    }
  }

  async services(): Promise<{ services: Record<string, ServiceMetadata> }> {
    const response = await fetch(`${this.#baseUrl}/services`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
    });

    const json = await response.json();
    return json;
  }

  async displayProperties({
    service,
    name,
    params,
  }: {
    service: string;
    name: string;
    params: any;
  }): Promise<DisplayProperties | undefined> {
    try {
      const url = `${this.#baseUrl}/${service}/action/${name}/display`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          params,
        }),
      });

      if (!response.ok) return undefined;
      const json = await response.json();

      if (!json.success) return undefined;
      return json.properties;
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }

  async registerWebhook({
    service,
    connectionId,
    externalSourceId,
    accessInfo,
    event,
    data,
    key,
  }: {
    service: string;
    connectionId: string;
    externalSourceId: string;
    accessInfo: AccessInfo;
    event: string;
    key: string;
    data: any;
  }): Promise<SubscribeResponse> {
    let credentials: ServiceSubscription["authentication"];
    switch (accessInfo.type) {
      case "oauth2":
        credentials = {
          type: "oauth",
          connectionId,
        };
        break;
      case "api_key":
        credentials = {
          type: "api-key",
          api_key: accessInfo.api_key,
        };
        break;
    }

    const callbackUrl = `${env.APP_ORIGIN}/api/v2/internal/webhooks/${externalSourceId}`;
    const body: Subscription = {
      type: "service",
      service,
      consumerId: connectionId,
      callbackUrl,
      authentication: credentials,
      data,
      eventName: event,
      key,
    };

    try {
      const response = await fetch(`${this.#baseUrl}/webhooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const json = await response.json();
      const parsedResult = SubscriptionResponseSchema.parse(json);

      return parsedResult;
    } catch (e) {
      console.error(e);
      return {
        success: false,
        error: {
          code: "unknown",
          message: JSON.stringify(e),
        },
      };
    }
  }
}

export const integrationsClient = new IntegrationsClient(
  env.INTEGRATIONS_API_ORIGIN,
  env.INTEGRATIONS_API_KEY
);
