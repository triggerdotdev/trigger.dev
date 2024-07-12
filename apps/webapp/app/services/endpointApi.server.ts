import { API_VERSIONS } from '@trigger.dev/core/versions';
import { type ConnectionAuth , EndpointHeadersSchema , ErrorWithStackSchema , ExecuteJobHeadersSchema , HttpSourceResponseSchema , IndexEndpointResponseSchema , NormalizedResponseSchema , type PongResponse , PongResponseSchema , type PreprocessRunBody , PreprocessRunResponseSchema , RegisterTriggerBodySchemaV1 , type RegisterTriggerBodyV1 , type RunJobBody , RunJobResponseSchema , type RunNotification , type ValidateResponse , ValidateResponseSchema , WebhookDeliveryResponseSchema } from '@trigger.dev/core/schemas';
import { performance } from "node:perf_hooks";
import { safeBodyFromResponse, safeParseBodyFromResponse } from "~/utils/json";
import { logger } from "./logger.server";
import { z } from "zod";

const HttpSourceRequestSchema = z.object({
  url: z.string().url(),
  method: z.string(),
  headers: z.record(z.string()),
  rawBody: z.instanceof(Buffer).optional().nullable(),
});

export type HttpSourceRequest = z.infer<typeof HttpSourceRequestSchema>;

export class EndpointApiError extends Error {
  constructor(message: string, stack?: string) {
    super(`EndpointApiError: ${message}`);
    this.stack = stack;
    this.name = "EndpointApiError";
  }
}

export class EndpointApi {
  constructor(private apiKey: string, private url: string) {}

  async ping(endpointId: string): Promise<PongResponse> {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "x-trigger-api-key": this.apiKey,
        "x-trigger-endpoint-id": endpointId,
        "x-trigger-action": "PING",
      },
    });

    if (!response) {
      return {
        ok: false,
        error: `Could not connect to endpoint ${this.url}`,
      };
    }

    if (response.status === 401) {
      const body = await safeBodyFromResponse(response, ErrorWithStackSchema);

      if (body) {
        return {
          ok: false,
          error: body.message,
        } as const;
      }

      return {
        ok: false,
        error: `Trigger API key is invalid`,
      } as const;
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `Could not connect to endpoint ${this.url}. Status code: ${response.status}`,
      };
    }

    const pongResponse = await safeParseBodyFromResponse(response, PongResponseSchema);

    if (!pongResponse) {
      return {
        ok: false,
        error: `Could not parse response from endpoint. Make sure it points to the correct URL (you might be missing /api/trigger)`,
      };
    }

    if (!pongResponse.success) {
      return {
        ok: false,
        error: `Endpoint ${this.url} responded with error: ${pongResponse.error.message}`,
      };
    }

    const headers = EndpointHeadersSchema.safeParse(Object.fromEntries(response.headers.entries()));

    if (headers.success && headers.data["trigger-version"]) {
      return {
        ...pongResponse.data,
        triggerVersion: headers.data["trigger-version"],
        triggerSdkVersion: headers.data["trigger-sdk-version"],
      };
    }

    return pongResponse.data;
  }

  async indexEndpoint() {
    const startTimeInMs = performance.now();
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "INDEX_ENDPOINT",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });

    return {
      response,
      headerParser: EndpointHeadersSchema,
      parser: IndexEndpointResponseSchema,
      errorParser: ErrorWithStackSchema,
      durationInMs: Math.floor(performance.now() - startTimeInMs),
    };
  }

  async executeJobRequest(options: RunJobBody, timeoutInMs?: number) {
    const startTimeInMs = performance.now();

    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "EXECUTE_JOB",
      },
      body: JSON.stringify(options),
      signal: timeoutInMs ? AbortSignal.timeout(timeoutInMs) : undefined,
    });

    if (response) {
      logger.debug("executeJobRequest() response from endpoint", {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      });
    } else {
      logger.debug("executeJobRequest() no response from endpoint");
    }

    return {
      response,
      parser: RunJobResponseSchema,
      errorParser: ErrorWithStackSchema,
      headersParser: ExecuteJobHeadersSchema,
      durationInMs: Math.floor(performance.now() - startTimeInMs),
    };
  }

  async preprocessRunRequest(options: PreprocessRunBody) {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "PREPROCESS_RUN",
      },
      body: JSON.stringify(options),
    });

    return { response, parser: PreprocessRunResponseSchema };
  }

  async initializeTrigger(id: string, params: any): Promise<RegisterTriggerBodyV1 | undefined> {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "INITIALIZE_TRIGGER",
      },
      body: JSON.stringify({ id, params }),
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.url}`);
    }

    if (!response.ok) {
      // Attempt to parse the error message
      const anyBody = await response.json();

      const error = ErrorWithStackSchema.safeParse(anyBody);

      if (error.success) {
        throw new EndpointApiError(error.data.message, error.data.stack);
      }

      throw new Error(`Could not connect to endpoint ${this.url}. Status code: ${response.status}`);
    }

    const anyBody = await response.json();

    logger.debug("initializeTrigger() response from endpoint", {
      body: anyBody,
    });

    return RegisterTriggerBodySchemaV1.parse(anyBody);
  }

  async deliverHttpSourceRequest(options: {
    key: string;
    dynamicId?: string;
    secret: string;
    params: any;
    data: any;
    request: HttpSourceRequest;
    auth?: ConnectionAuth;
    metadata?: any;
  }) {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "DELIVER_HTTP_SOURCE_REQUEST",
        "x-ts-key": options.key,
        "x-ts-secret": options.secret,
        "x-ts-params": JSON.stringify(options.params ?? {}),
        "x-ts-data": JSON.stringify(options.data ?? {}),
        "x-ts-http-url": options.request.url,
        "x-ts-http-method": options.request.method,
        "x-ts-http-headers": JSON.stringify(options.request.headers),
        ...(options.auth && { "x-ts-auth": JSON.stringify(options.auth) }),
        ...(options.dynamicId && { "x-ts-dynamic-id": options.dynamicId }),
        ...(options.metadata && { "x-ts-metadata": JSON.stringify(options.metadata) }),
      },
      body: options.request.rawBody,
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.url}`);
    }

    if (!response.ok) {
      throw new Error(`Could not connect to endpoint ${this.url}. Status code: ${response.status}`);
    }

    const anyBody = await response.json();

    logger.debug("deliverHttpSourceRequest() response from endpoint", {
      body: anyBody,
    });

    return HttpSourceResponseSchema.parse(anyBody);
  }

  async deliverWebhookRequest(options: {
    key: string;
    secret: string;
    params: any;
    request: HttpSourceRequest;
  }) {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "DELIVER_WEBHOOK_REQUEST",
        "x-ts-key": options.key,
        "x-ts-secret": options.secret,
        "x-ts-params": JSON.stringify(options.params ?? {}),
        "x-ts-http-url": options.request.url,
        "x-ts-http-method": options.request.method,
        "x-ts-http-headers": JSON.stringify(options.request.headers),
      },
      body: options.request.rawBody,
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.url}`);
    }

    if (!response.ok) {
      throw new Error(`Could not connect to endpoint ${this.url}. Status code: ${response.status}`);
    }

    const anyBody = await response.json();

    logger.debug("deliverWebhookRequest() response from endpoint", {
      body: anyBody,
    });

    return WebhookDeliveryResponseSchema.parse(anyBody);
  }

  async deliverHttpEndpointRequestForResponse(options: {
    key: string;
    secret: string;
    request: HttpSourceRequest;
  }) {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "DELIVER_HTTP_ENDPOINT_REQUEST_FOR_RESPONSE",
        "x-ts-key": options.key,
        "x-ts-http-url": options.request.url,
        "x-ts-http-method": options.request.method,
        "x-ts-http-headers": JSON.stringify(options.request.headers),
      },
      body: options.request.rawBody,
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.url}`);
    }

    if (!response.ok) {
      throw new Error(`Could not connect to endpoint ${this.url}. Status code: ${response.status}`);
    }

    return { response, parser: NormalizedResponseSchema };
  }

  async validate(): Promise<ValidateResponse> {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "VALIDATE",
      },
    });

    if (!response) {
      return {
        ok: false,
        error: `Could not connect to endpoint ${this.url}`,
      };
    }

    if (response.status === 401) {
      const body = await safeBodyFromResponse(response, ErrorWithStackSchema);

      if (body) {
        return {
          ok: false,
          error: body.message,
        } as const;
      }

      return {
        ok: false,
        error: `Trigger API key is invalid`,
      } as const;
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `Could not connect to endpoint ${this.url}. Status code: ${response.status}`,
      };
    }

    const validateResponse = await safeParseBodyFromResponse(response, ValidateResponseSchema);

    if (!validateResponse) {
      return {
        ok: false,
        error: `Could not parse response from endpoint. Make sure it points to the correct URL (you might be missing /api/trigger)`,
      };
    }

    if (!validateResponse.success) {
      return {
        ok: false,
        error: `Endpoint ${this.url} responded with error: ${validateResponse.error.message}`,
      };
    }

    const headers = EndpointHeadersSchema.safeParse(Object.fromEntries(response.headers.entries()));

    if (headers.success && headers.data["trigger-version"]) {
      return {
        ...validateResponse.data,
        triggerVersion: headers.data["trigger-version"],
      };
    }

    return validateResponse.data;
  }

  async probe(timeout: number) {
    const startTimeInMs = performance.now();

    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "PROBE_EXECUTION_TIMEOUT",
      },
      body: JSON.stringify({
        timeout,
      }),
    });

    return {
      response,
      durationInMs: Math.floor(performance.now() - startTimeInMs),
    };
  }

  async deliverRunNotification(notification: RunNotification<any>) {
    const response = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trigger-api-key": this.apiKey,
        "x-trigger-action": "RUN_NOTIFICATION",
      },
      body: JSON.stringify(notification),
    });

    return response;
  }
}

async function safeFetch(url: string, options: RequestInit) {
  try {
    return await fetch(url, addStandardRequestOptions(options));
  } catch (error) {
    logger.debug("Error while trying to connect to endpoint", {
      url,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    });
  }
}

function addStandardRequestOptions(options: RequestInit) {
  return {
    ...options,
    headers: {
      ...options.headers,
      "user-agent": "triggerdotdev-server/2.0.0",
      "x-trigger-version": API_VERSIONS.LAZY_LOADED_CACHED_TASKS,
      accept: "application/json",
    },
  };
}
