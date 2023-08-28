import {
  ApiEventLog,
  ApiEventLogSchema,
  CompleteTaskBodyInput,
  ConnectionAuthSchema,
  FailTaskBodyInput,
  GetEventSchema,
  GetRunOptionsWithTaskDetails,
  GetRunSchema,
  GetRunsOptions,
  GetRunsSchema,
  LogLevel,
  Logger,
  RegisterScheduleResponseBodySchema,
  RegisterSourceEvent,
  RegisterSourceEventSchema,
  RegisterTriggerBody,
  RunTaskBodyInput,
  ScheduleMetadata,
  SendEvent,
  SendEventOptions,
  ServerTaskSchema,
  TriggerSource,
  TriggerSourceSchema,
  UpdateTriggerSourceBody,
  urlWithSearchParams,
} from "@trigger.dev/core";

import fetch, { type RequestInit } from "node-fetch";
import { z } from "zod";

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

export class ApiClient {
  #apiUrl: string;
  #options: ApiClientOptions;
  #logger: Logger;

  constructor(options: ApiClientOptions) {
    this.#options = options;

    this.#apiUrl = this.#options.apiUrl ?? process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);
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

  async runTask(runId: string, task: RunTaskBodyInput) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Running Task", {
      task,
    });

    return await zodfetch(ServerTaskSchema, `${this.#apiUrl}/api/v1/runs/${runId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": task.idempotencyKey,
      },
      body: JSON.stringify(task),
    });
  }

  async completeTask(runId: string, id: string, task: CompleteTaskBodyInput) {
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

  async updateSource(
    client: string,
    key: string,
    source: UpdateTriggerSourceBody
  ): Promise<TriggerSource> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("activating http source", {
      source,
    });

    const response = await zodfetch(
      TriggerSourceSchema,
      `${this.#apiUrl}/api/v1/${client}/sources/${key}`,
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

  async registerTrigger(
    client: string,
    id: string,
    key: string,
    payload: RegisterTriggerBody
  ): Promise<RegisterSourceEvent> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("registering trigger", {
      id,
      payload,
    });

    const response = await zodfetch(
      RegisterSourceEventSchema,
      `${this.#apiUrl}/api/v1/${client}/triggers/${id}/registrations/${key}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
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

    return await zodfetch(GetEventSchema, `${this.#apiUrl}/api/v1/events/${eventId}`, {
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
      urlWithSearchParams(`${this.#apiUrl}/api/v1/runs/${runId}`, options),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
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
  const apiKey = key ?? process.env.TRIGGER_API_KEY;

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

async function zodfetch<TResponseBody extends any, TOptional extends boolean = false>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit,
  options?: {
    errorMessage?: string;
    optional?: TOptional;
  }
): Promise<TOptional extends true ? TResponseBody | undefined : TResponseBody> {
  const response = await fetch(url, requestInit);

  if (
    (!requestInit || requestInit.method === "GET") &&
    response.status === 404 &&
    options?.optional
  ) {
    // @ts-ignore
    return;
  }

  if (response.status >= 400 && response.status < 500) {
    const body = await response.json();

    throw new Error(body.error);
  }

  if (response.status !== 200) {
    throw new Error(
      options?.errorMessage ?? `Failed to fetch ${url}, got status code ${response.status}`
    );
  }

  const jsonBody = await response.json();

  return schema.parse(jsonBody);
}
