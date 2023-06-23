import fetch from "node-fetch";

export type CreateEndpointOptions = {
  id: string;
  url: string;
};

export type EndpointResponse = {
  id: string;
  slug: string;
  url: string;
  environmentId: string;
  organizationId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  indexingHookIdentifier: string;
};

export class TriggerApi {
  constructor(private apiKey: string, private baseUrl: string) {}

  async createEndpoint(
    options: CreateEndpointOptions
  ): Promise<EndpointResponse | undefined> {
    const response = await fetch(`${this.baseUrl}/api/v1/endpoints`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(options),
    });

    if (response.ok) {
      return response.json() as Promise<EndpointResponse>;
    }

    return;
  }
}
