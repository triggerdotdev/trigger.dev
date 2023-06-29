import fetch from "node-fetch";
import { z } from "zod";

export type CreateEndpointOptions = {
  id: string;
  url: string;
};

export type EndpointData = {
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

export type EndpointResponse =
  | {
      ok: true;
      data: EndpointData;
    }
  | { ok: false; error: string };

export class TriggerApi {
  constructor(private apiKey: string, private baseUrl: string) {}

  async registerEndpoint(
    options: CreateEndpointOptions
  ): Promise<EndpointResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/endpoints`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      const rawBody = await response.text();

      if (typeof rawBody === "string") {
        const rawJson = safeJsonParse(rawBody);

        if (!rawJson) {
          return {
            ok: false,
            error:
              "An unknown issue occurred when registering with Trigger.dev",
          };
        }

        const parsedJson = z.object({ message: z.string() }).safeParse(rawJson);

        if (!parsedJson.success) {
          return {
            ok: false,
            error:
              "An unknown issue occurred when registering with Trigger.dev",
          };
        }

        return {
          ok: false,
          error: parsedJson.data.message,
        };
      } else {
        return {
          ok: false,
          error: "An unknown issue occurred when registering with Trigger.dev",
        };
      }
    }

    const data = await response.json();

    return {
      ok: true,
      data: data as any as EndpointData,
    };
  }
}

function safeJsonParse(raw: string | null | undefined): unknown {
  if (typeof raw !== "string") {
    return;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return;
  }
}
