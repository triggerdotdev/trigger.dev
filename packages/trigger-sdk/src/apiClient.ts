import {
  API_VERSIONS,
  ApiEventLog,
  ApiEventLogSchema,
  CancelRunsForEventSchema,
  CancelRunsForJobSchema,
  CompleteTaskBodyV2Input,
  ConnectionAuthSchema,
  EphemeralEventDispatcherRequestBody,
  EphemeralEventDispatcherResponseBodySchema,
  FailTaskBodyInput,
  GetEventSchema,
  GetRunOptionsWithTaskDetails,
  GetRunSchema,
  GetRunStatusesSchema,
  GetRunsOptions,
  GetRunsSchema,
  InvokeJobRequestBody,
  InvokeJobResponseSchema,
  InvokeOptions,
  JobRunStatusRecordSchema,
  KeyValueStoreResponseBody,
  KeyValueStoreResponseBodySchema,
  RegisterScheduleResponseBodySchema,
  RegisterSourceEventSchemaV2,
  RegisterSourceEventV2,
  RegisterTriggerBodyV2,
  RunTaskBodyInput,
  RunTaskResponseWithCachedTasksBodySchema,
  ScheduleMetadata,
  SendEvent,
  SendEventOptions,
  ServerTaskSchema,
  StatusUpdate,
  TriggerSource,
  TriggerSourceSchema,
  UpdateTriggerSourceBodyV2,
  UpdateWebhookBody,
  assertExhaustive,
  urlWithSearchParams,
} from "@trigger.dev/core";
import { LogLevel, Logger } from "@trigger.dev/core/logger";
import { env } from "node:process";

import { z } from "zod";
import { KeyValueStoreClient } from "./store/keyValueStoreClient";
import { AutoYieldRateLimitError } from "./errors";

export type ApiClientOptions = {
  apiKey?: string;
  apiUrl?: string;
  logLevel?: LogLevel;
};

export type EndpointRecord = {
  id: string;
  name: string;
  url: string;
};

export type HttpSourceRecord = {
  id: string;
  key: string;
  managed: boolean;
  url: string;
  status: "PENDING" | "ACTIVE" | "INACTIVE";
  secret?: string;
  data?: any;
};

export type RunRecord = {
  id: string;
  jobId: string;
  callbackUrl: string;
  event: ApiEventLog;
};

export class UnknownVersionError extends Error {
  constructor(version: string) {
    super(`Unknown version ${version}`);
  }
}

const MAX_RETRIES = 8;
const EXPONENT_FACTOR = 2;
const MIN_DELAY_IN_MS = 80;
const MAX_DELAY_IN_MS = 2000;
const JITTER_IN_MS = 50;

export class ApiClient {
  #apiUrl: string;
  #options: ApiClientOptions;
  #logger: Logger;
  #storeClient: KeyValueStoreClient;

  constructor(options: ApiClientOptions) {
    this.#options = options;

    this.#apiUrl = this.#options.apiUrl ?? env.TRIGGER_API_URL ?? "https://api.trigger.dev";
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);

    this.#storeClient = new KeyValueStoreClient(this.#queryKeyValueStore.bind(this));
  }

  async registerEndpoint(options: { url: string; name: string }): Promise<EndpointRecord> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Registering endpoint", {
      url: options.url,
      name: options.name,
    });

    const response = await fetch(`${this.#apiUrl}/api/v1/endpoints`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: options.url,
        name: options.name,
      }),
    });

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(`Failed to register entry point, got status code ${response.status}`);
    }

    return await response.json();
  }

  async runTask(
    runId: string,
    task: RunTaskBodyInput,
    options: { cachedTasksCursor?: string } = {}
  ) {
    const apiKey = await this.#apiKey();

    this.#logger.debug(`[ApiClient] runTask ${task.displayKey}`);

    return await zodfetchWithVersions(
      this.#logger,
      {
        [API_VERSIONS.LAZY_LOADED_CACHED_TASKS]: RunTaskResponseWithCachedTasksBodySchema,
      },
      ServerTaskSchema,
      `${this.#apiUrl}/api/v1/runs/${runId}/tasks`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": task.idempotencyKey,
          "X-Cached-Tasks-Cursor": options.cachedTasksCursor ?? "",
          "Trigger-Version": API_VERSIONS.LAZY_LOADED_CACHED_TASKS,
        },
        body: JSON.stringify(task),
      }
    );
  }

  async completeTask(runId: string, id: string, task: CompleteTaskBodyV2Input) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Complete Task", {
      task,
    });

    return await zodfetch(
      ServerTaskSchema,
      `${this.#apiUrl}/api/v1/runs/${runId}/tasks/${id}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Trigger-Version": API_VERSIONS.SERIALIZED_TASK_OUTPUT,
        },
        body: JSON.stringify(task),
      }
    );
  }

  async failTask(runId: string, id: string, body: FailTaskBodyInput) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Fail Task", {
      id,
      runId,
      body,
    });

    return await zodfetch(
      ServerTaskSchema,
      `${this.#apiUrl}/api/v1/runs/${runId}/tasks/${id}/fail`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }
    );
  }

  async sendEvent(event: SendEvent, options: SendEventOptions = {}) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Sending event", {
      event,
    });

    return await zodfetch(ApiEventLogSchema, `${this.#apiUrl}/api/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ event, options }),
    });
  }

  async sendEvents(events: SendEvent[], options: SendEventOptions = {}) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Sending multiple events", {
      events,
    });

    return await zodfetch(ApiEventLogSchema.array(), `${this.#apiUrl}/api/v1/events/bulk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ events, options }),
    });
  }

  async cancelEvent(eventId: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Cancelling event", {
      eventId,
    });

    return await zodfetch(ApiEventLogSchema, `${this.#apiUrl}/api/v1/events/${eventId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  async cancelRunsForEvent(eventId: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Cancelling runs for event", {
      eventId,
    });

    return await zodfetch(
      CancelRunsForEventSchema,
      `${this.#apiUrl}/api/v1/events/${eventId}/cancel-runs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
  }

  async updateStatus(runId: string, id: string, status: StatusUpdate) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Update status", {
      id,
      status,
    });

    return await zodfetch(
      JobRunStatusRecordSchema,
      `${this.#apiUrl}/api/v1/runs/${runId}/statuses/${id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(status),
      }
    );
  }

  async updateSource(
    client: string,
    key: string,
    source: UpdateTriggerSourceBodyV2
  ): Promise<TriggerSource> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("activating http source", {
      source,
    });

    const response = await zodfetch(
      TriggerSourceSchema,
      `${this.#apiUrl}/api/v2/${client}/sources/${key}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(source),
      }
    );

    return response;
  }

  async updateWebhook(key: string, webhookData: UpdateWebhookBody): Promise<TriggerSource> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("activating webhook", {
      webhookData,
    });

    const response = await zodfetch(TriggerSourceSchema, `${this.#apiUrl}/api/v1/webhooks/${key}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(webhookData),
    });

    return response;
  }

  async registerTrigger(
    client: string,
    id: string,
    key: string,
    payload: RegisterTriggerBodyV2,
    idempotencyKey?: string
  ): Promise<RegisterSourceEventV2> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("registering trigger", {
      id,
      payload,
    });

    const headers: HeadersInit = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const response = await zodfetch(
      RegisterSourceEventSchemaV2,
      `${this.#apiUrl}/api/v2/${client}/triggers/${id}/registrations/${key}`,
      {
        method: "PUT",
        headers: headers,
        body: JSON.stringify(payload),
      }
    );

    return response;
  }

  async registerSchedule(client: string, id: string, key: string, payload: ScheduleMetadata) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("registering schedule", {
      id,
      payload,
    });

    const response = await zodfetch(
      RegisterScheduleResponseBodySchema,
      `${this.#apiUrl}/api/v1/${client}/schedules/${id}/registrations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ id: key, ...payload }),
      }
    );

    return response;
  }

  async unregisterSchedule(client: string, id: string, key: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("unregistering schedule", {
      id,
    });

    const response = await zodfetch(
      z.object({ ok: z.boolean() }),
      `${this.#apiUrl}/api/v1/${client}/schedules/${id}/registrations/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response;
  }

  async getAuth(client: string, id: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("getting auth", {
      id,
    });

    const response = await zodfetch(
      ConnectionAuthSchema,
      `${this.#apiUrl}/api/v1/${client}/auth/${id}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      {
        optional: true,
      }
    );

    return response;
  }

  async getEvent(eventId: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Getting Event", {
      eventId,
    });

    return await zodfetch(GetEventSchema, `${this.#apiUrl}/api/v2/events/${eventId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  async getRun(runId: string, options?: GetRunOptionsWithTaskDetails) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Getting Run", {
      runId,
    });

    return await zodfetch(
      GetRunSchema,
      urlWithSearchParams(`${this.#apiUrl}/api/v2/runs/${runId}`, options),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
  }

  async cancelRun(runId: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Cancelling Run", {
      runId,
    });

    return await zodfetch(GetRunSchema, `${this.#apiUrl}/api/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  async getRunStatuses(runId: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Getting Run statuses", {
      runId,
    });

    return await zodfetch(GetRunStatusesSchema, `${this.#apiUrl}/api/v2/runs/${runId}/statuses`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  async getRuns(jobSlug: string, options?: GetRunsOptions) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Getting Runs", {
      jobSlug,
    });

    return await zodfetch(
      GetRunsSchema,
      urlWithSearchParams(`${this.#apiUrl}/api/v1/jobs/${jobSlug}/runs`, options),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
  }

  async invokeJob(jobId: string, payload: any, options: InvokeOptions = {}) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Invoking Job", {
      jobId,
    });

    const body: InvokeJobRequestBody = {
      payload,
      context: options.context ?? {},
      options: {
        accountId: options.accountId,
        callbackUrl: options.callbackUrl,
      },
    };

    return await zodfetch(InvokeJobResponseSchema, `${this.#apiUrl}/api/v1/jobs/${jobId}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async cancelRunsForJob(jobId: string) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Cancelling Runs for Job", {
      jobId,
    });

    return await zodfetch(
      CancelRunsForJobSchema,
      `${this.#apiUrl}/api/v1/jobs/${jobId}/cancel-runs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
  }

  async createEphemeralEventDispatcher(payload: EphemeralEventDispatcherRequestBody) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Creating ephemeral event dispatcher", {
      payload,
    });

    const response = await zodfetch(
      EphemeralEventDispatcherResponseBodySchema,
      `${this.#apiUrl}/api/v1/event-dispatchers/ephemeral`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      }
    );

    return response;
  }

  get store() {
    return this.#storeClient;
  }

  async #queryKeyValueStore(
    action: KeyValueStoreResponseBody["action"],
    data: {
      key: string;
      value?: string;
    }
  ): Promise<KeyValueStoreResponseBody> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("accessing key-value store", {
      action,
      data,
    });

    const encodedKey = encodeURIComponent(data.key);

    const STORE_URL = `${this.#apiUrl}/api/v1/store/${encodedKey}`;

    const authHeader: HeadersInit = {
      Authorization: `Bearer ${apiKey}`,
    };

    let requestInit: RequestInit | undefined;

    switch (action) {
      case "DELETE": {
        requestInit = {
          method: "DELETE",
          headers: authHeader,
        };

        break;
      }
      case "GET": {
        requestInit = {
          method: "GET",
          headers: authHeader,
        };

        break;
      }
      case "HAS": {
        const headResponse = await fetchHead(STORE_URL, {
          headers: authHeader,
        });

        return {
          action: "HAS",
          key: encodedKey,
          has: !!headResponse.ok,
        };
      }
      case "SET": {
        const MAX_BODY_BYTE_LENGTH = 256 * 1024;

        if ((data.value?.length ?? 0) > MAX_BODY_BYTE_LENGTH) {
          throw new Error(`Max request body size exceeded: ${MAX_BODY_BYTE_LENGTH} bytes`);
        }

        requestInit = {
          method: "PUT",
          headers: {
            ...authHeader,
            "Content-Type": "text/plain",
          },
          body: data.value,
        };

        break;
      }
      default: {
        assertExhaustive(action);
      }
    }

    const response = await zodfetch(KeyValueStoreResponseBodySchema, STORE_URL, requestInit);

    return response;
  }

  async #apiKey() {
    const apiKey = getApiKey(this.#options.apiKey);

    if (apiKey.status === "invalid") {
      throw new Error("Invalid API key");

      // const chalk = (await import("chalk")).default;
      // const terminalLink = (await import("terminal-link")).default;

      // throw new Error(
      //   `${chalk.red("Trigger.dev error")}: Invalid API key ("${chalk.italic(
      //     apiKey.apiKey
      //   )}"), please set the TRIGGER_API_KEY environment variable or pass the apiKey option to a valid value. ${terminalLink(
      //     "Get your API key here",
      //     "https://app.trigger.dev",
      //     {
      //       fallback(text, url) {
      //         return `${text} 👉 ${url}`;
      //       },
      //     }
      //   )}`
      // );
    } else if (apiKey.status === "missing") {
      throw new Error("Missing API key");
      // const chalk = (await import("chalk")).default;
      // const terminalLink = (await import("terminal-link")).default;

      // throw new Error(
      //   `${chalk.red(
      //     "Trigger.dev error"
      //   )}: Missing an API key, please set the TRIGGER_API_KEY environment variable or pass the apiKey option to the Trigger constructor. ${terminalLink(
      //     "Get your API key here",
      //     "https://app.trigger.dev",
      //     {
      //       fallback(text, url) {
      //         return `${text} 👉 ${url}`;
      //       },
      //     }
      //   )}`
      // );
    }

    return apiKey.apiKey;
  }
}

function getApiKey(key?: string) {
  const apiKey = key ?? env.TRIGGER_API_KEY;

  if (!apiKey) {
    return { status: "missing" as const };
  }

  // Validate the api_key format (should be tr_{env}_XXXXX)
  const isValid = apiKey.match(/^tr_[a-z]+_[a-zA-Z0-9]+$/);

  if (!isValid) {
    return { status: "invalid" as const, apiKey };
  }

  return { status: "valid" as const, apiKey };
}

type VersionedResponseBodyMap = {
  [key: string]: z.ZodTypeAny;
};

// The resulting type should be a discriminating union
// For example, if the TVersions param is { "2023_09_29": z.string() } and the TUnversioned param is z.number(), the resulting type should be:
// type VersionedResponseBody = { version: "2023_09_29"; body: string } | { version: "unversioned"; body: number }
type VersionedResponseBody<
  TVersions extends VersionedResponseBodyMap,
  TUnversioned extends z.ZodTypeAny,
> =
  | {
      [TVersion in keyof TVersions]: {
        version: TVersion;
        body: z.infer<TVersions[TVersion]>;
      };
    }[keyof TVersions]
  | {
      version: "unversioned";
      body: z.infer<TUnversioned>;
    };

async function zodfetchWithVersions<
  TVersionedResponseBodyMap extends VersionedResponseBodyMap,
  TUnversionedResponseBodySchema extends z.ZodTypeAny,
  TOptional extends boolean = false,
>(
  logger: Logger,
  versionedSchemaMap: TVersionedResponseBodyMap,
  unversionedSchema: TUnversionedResponseBodySchema,
  url: string,
  requestInit?: RequestInit,
  options?: {
    errorMessage?: string;
    optional?: TOptional;
  },
  retryCount = 0
): Promise<
  TOptional extends true
    ? VersionedResponseBody<TVersionedResponseBodyMap, TUnversionedResponseBodySchema> | undefined
    : VersionedResponseBody<TVersionedResponseBodyMap, TUnversionedResponseBodySchema>
> {
  try {
    const fullRequestInit = requestInitWithCache(requestInit);

    const response = await fetch(url, fullRequestInit);

    logger.debug(`[ApiClient] zodfetchWithVersions ${url} (attempt ${retryCount + 1})`, {
      url,
      retryCount,
      requestHeaders: fullRequestInit?.headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
    });

    if (
      (!requestInit || requestInit.method === "GET") &&
      response.status === 404 &&
      options?.optional
    ) {
      // @ts-ignore
      return;
    }

    //rate limit, so we want to reschedule
    if (response.status === 429) {
      //unix timestamp in milliseconds
      const retryAfter = response.headers.get("x-ratelimit-reset");
      if (retryAfter) {
        throw new AutoYieldRateLimitError(parseInt(retryAfter));
      }
    }

    if (response.status >= 400 && response.status < 500) {
      const rawBody = await safeResponseText(response);
      const body = safeJsonParse(rawBody);

      logger.error(`[ApiClient] zodfetchWithVersions failed with ${response.status}`, {
        url,
        retryCount,
        requestHeaders: fullRequestInit?.headers,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        status: response.status,
        rawBody,
      });

      if (body && body.error) {
        throw new Error(body.error);
      } else {
        throw new Error(rawBody);
      }
    }

    if (response.status >= 500 && retryCount < MAX_RETRIES) {
      // retry with exponential backoff and jitter
      const delay = exponentialBackoff(retryCount + 1);

      await new Promise((resolve) => setTimeout(resolve, delay));

      return zodfetchWithVersions(
        logger,
        versionedSchemaMap,
        unversionedSchema,
        url,
        requestInit,
        options,
        retryCount + 1
      );
    }

    if (response.status !== 200) {
      const rawBody = await safeResponseText(response);

      logger.error(`[ApiClient] zodfetchWithVersions failed with ${response.status}`, {
        url,
        retryCount,
        requestHeaders: fullRequestInit?.headers,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        status: response.status,
        rawBody,
      });

      throw new Error(
        options?.errorMessage ?? `Failed to fetch ${url}, got status code ${response.status}`
      );
    }

    const jsonBody = await response.json();

    const version = response.headers.get("trigger-version");

    if (!version) {
      return {
        version: "unversioned",
        body: unversionedSchema.parse(jsonBody),
      };
    }

    const versionedSchema = versionedSchemaMap[version];

    if (!versionedSchema) {
      throw new UnknownVersionError(version);
    }

    return {
      version,
      body: versionedSchema.parse(jsonBody),
    };
  } catch (error) {
    if (error instanceof UnknownVersionError || error instanceof AutoYieldRateLimitError) {
      throw error;
    }

    logger.error(`[ApiClient] zodfetchWithVersions failed with a connection error`, {
      url,
      retryCount,
      error,
    });

    if (retryCount < MAX_RETRIES) {
      // retry with exponential backoff and jitter
      const delay = exponentialBackoff(retryCount + 1);

      await new Promise((resolve) => setTimeout(resolve, delay));

      return zodfetchWithVersions(
        logger,
        versionedSchemaMap,
        unversionedSchema,
        url,
        requestInit,
        options,
        retryCount + 1
      );
    }

    throw error;
  }
}

function requestInitWithCache(requestInit?: RequestInit): RequestInit {
  try {
    const withCache: RequestInit = {
      ...requestInit,
      cache: "no-cache",
    };

    const _ = new Request("http://localhost", withCache);

    return withCache;
  } catch (error) {
    return requestInit ?? {};
  }
}

async function fetchHead(
  url: string,
  requestInitWithoutMethod?: Omit<RequestInit, "method">,
  retryCount = 0
): Promise<Response> {
  const requestInit: RequestInit = {
    ...requestInitWithoutMethod,
    method: "HEAD",
  };
  const response = await fetch(url, requestInitWithCache(requestInit));

  if (response.status >= 500 && retryCount < MAX_RETRIES) {
    // retry with exponential backoff and jitter
    const delay = exponentialBackoff(retryCount + 1);

    await new Promise((resolve) => setTimeout(resolve, delay));

    return fetchHead(url, requestInitWithoutMethod, retryCount + 1);
  }

  return response;
}

async function zodfetch<TResponseSchema extends z.ZodTypeAny, TOptional extends boolean = false>(
  schema: TResponseSchema,
  url: string,
  requestInit?: RequestInit,
  options?: {
    errorMessage?: string;
    optional?: TOptional;
  },
  retryCount = 0
): Promise<
  TOptional extends true ? z.infer<TResponseSchema> | undefined : z.infer<TResponseSchema>
> {
  try {
    const response = await fetch(url, requestInitWithCache(requestInit));

    if (
      (!requestInit || requestInit.method === "GET") &&
      response.status === 404 &&
      options?.optional
    ) {
      // @ts-ignore
      return;
    }

    //rate limit, so we want to reschedule
    if (response.status === 429) {
      //unix timestamp in milliseconds
      const retryAfter = response.headers.get("x-ratelimit-reset");
      if (retryAfter) {
        throw new AutoYieldRateLimitError(parseInt(retryAfter));
      }
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status >= 500 && retryCount < MAX_RETRIES) {
      // retry with exponential backoff and jitter
      const delay = exponentialBackoff(retryCount + 1);

      await new Promise((resolve) => setTimeout(resolve, delay));

      return zodfetch(schema, url, requestInit, options, retryCount + 1);
    }

    if (response.status !== 200) {
      throw new Error(
        options?.errorMessage ?? `Failed to fetch ${url}, got status code ${response.status}`
      );
    }

    const jsonBody = await response.json();

    return schema.parse(jsonBody);
  } catch (error) {
    if (error instanceof AutoYieldRateLimitError) {
      throw error;
    }

    if (retryCount < MAX_RETRIES) {
      // retry with exponential backoff and jitter
      const delay = exponentialBackoff(retryCount + 1);

      await new Promise((resolve) => setTimeout(resolve, delay));

      return zodfetch(schema, url, requestInit, options, retryCount + 1);
    }

    throw error;
  }
}

// First retry will have a delay of 80ms, second 160ms, third 320ms, etc.
function exponentialBackoff(retryCount: number): number {
  // Calculate the delay using the exponential backoff formula
  const delay = Math.min(Math.pow(EXPONENT_FACTOR, retryCount) * MIN_DELAY_IN_MS, MAX_DELAY_IN_MS);

  // Calculate the jitter
  const jitterValue = Math.random() * JITTER_IN_MS;

  // Return the calculated delay with jitter
  return delay + jitterValue;
}

function safeJsonParse(rawBody: string) {
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    return;
  }
}

async function safeResponseText(response: Response) {
  try {
    return await response.text();
  } catch (error) {
    return "";
  }
}
