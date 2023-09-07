import {
  DeployBackgroundTaskRequestBody,
  DeployBackgroundTaskResponseBody,
} from "@trigger.dev/core";
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

export type ApiResponse<TData> =
  | {
      ok: true;
      data: TData;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
    };

export type EndpointResponse =
  | {
      ok: true;
      data: EndpointData;
    }
  | { ok: false; error: string; retryable: boolean };

const RETRYABLE_PATTERN = /Could not connect to endpoint/i;

const WhoamiResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  type: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  project: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  }),
  organization: z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  }),
  userId: z.string().optional(),
});

export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;

export class TriggerApi {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.trigger.dev"
  ) {}

  async whoami(apiKey: string): Promise<WhoamiResponse | undefined> {
    const response = await fetch(`${this.baseUrl}/api/v1/whoami`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.ok) {
      const body = await response.json();

      const parsed = WhoamiResponseSchema.safeParse(body);

      if (parsed.success) {
        return parsed.data;
      }
    }

    return;
  }

  async sendEvent(id: string, name: string, payload: any) {
    const response = await fetch(`${this.baseUrl}/api/v1/events`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        event: {
          id,
          name,
          payload,
        },
      }),
    });

    return response.ok;
  }

  async registerEndpoint(options: CreateEndpointOptions): Promise<EndpointResponse> {
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
            error: "An unknown issue occurred when registering with Trigger.dev",
            retryable: true,
          };
        }

        const parsedJson = z.object({ error: z.string() }).safeParse(rawJson);

        if (!parsedJson.success) {
          return {
            ok: false,
            error: "An unknown issue occurred when registering with Trigger.dev",
            retryable: true,
          };
        }

        return {
          ok: false,
          error: parsedJson.data.error,
          retryable: RETRYABLE_PATTERN.test(parsedJson.data.error),
        };
      } else {
        return {
          ok: false,
          error: "An unknown issue occurred when registering with Trigger.dev",
          retryable: true,
        };
      }
    }

    const data = await response.json();

    return {
      ok: true,
      data: data as any as EndpointData,
    };
  }

  async deployBackgroundTask(
    options: DeployBackgroundTaskRequestBody
  ): Promise<ApiResponse<DeployBackgroundTaskResponseBody>> {
    const response = await fetch(`${this.baseUrl}/api/v1/background/tasks`, {
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
            error: "An unknown issue occurred deploying to Trigger.dev",
            retryable: true,
          };
        }

        const parsedJson = z.object({ error: z.string() }).safeParse(rawJson);

        if (!parsedJson.success) {
          return {
            ok: false,
            error: "An unknown issue occurred deploying to Trigger.dev",
            retryable: true,
          };
        }

        return {
          ok: false,
          error: parsedJson.data.error,
          retryable: RETRYABLE_PATTERN.test(parsedJson.data.error),
        };
      } else {
        return {
          ok: false,
          error: "An unknown issue occurred deploying to Trigger.dev",
          retryable: true,
        };
      }
    }

    const data = await response.json();

    return {
      ok: true,
      data: data as any as DeployBackgroundTaskResponseBody,
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
