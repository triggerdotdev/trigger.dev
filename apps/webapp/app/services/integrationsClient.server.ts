import type { IntegrationRequest } from ".prisma/client";
import type {
  AccessInfo,
  DisplayProperties,
  PerformedRequestResponse,
  ServiceMetadata,
} from "@trigger.dev/integration-sdk";
import { env } from "~/env.server";

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
}

export const integrationsClient = new IntegrationsClient(
  env.INTEGRATIONS_API_ORIGIN,
  env.INTEGRATIONS_API_KEY
);
