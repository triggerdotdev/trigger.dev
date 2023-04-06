import type {
  ApiEventLog,
  CachedTask,
  ExecuteJobBody,
  ServerTask,
} from "@trigger.dev/internal";
import { ErrorWithStackSchema } from "@trigger.dev/internal";
import {
  DeliverEventResponseSchema,
  ExecuteJobResponseSchema,
  GetJobsResponseSchema,
  PongResponseSchema,
} from "@trigger.dev/internal";
import { logger } from "./logger";

export class ClientApiError extends Error {
  constructor(message: string, stack?: string) {
    super(message);
    this.stack = stack;
    this.name = "ClientApiError";
  }
}

export class ClientApi {
  #apiKey: string;
  #url: string;

  constructor(apiKey: string, url: string) {
    this.#apiKey = apiKey;
    this.#url = url;
  }

  async ping() {
    const response = await safeFetch(this.#url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-api-key": this.#apiKey,
        "x-trigger-action": "PING",
      },
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.#url}`);
    }

    if (!response.ok) {
      throw new Error(
        `Could not connect to endpoint ${this.#url}. Status code: ${
          response.status
        }`
      );
    }

    const anyBody = await response.json();

    logger.debug("ping() response from endpoint", {
      body: anyBody,
    });

    return PongResponseSchema.parse(anyBody);
  }

  async getJobs() {
    const response = await safeFetch(this.#url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-api-key": this.#apiKey,
      },
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.#url}`);
    }

    if (!response.ok) {
      throw new Error(
        `Could not connect to endpoint ${this.#url}. Status code: ${
          response.status
        }`
      );
    }

    const anyBody = await response.json();

    logger.debug("getJobs() response from endpoint", {
      body: anyBody,
    });

    return GetJobsResponseSchema.parse(anyBody);
  }

  async deliverEvent(event: ApiEventLog) {
    const response = await safeFetch(this.#url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-api-key": this.#apiKey,
        "x-trigger-action": "DELIVER_EVENT",
      },
      body: JSON.stringify(event),
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.#url}`);
    }

    if (!response.ok) {
      throw new Error(
        `Could not connect to endpoint ${this.#url}. Status code: ${
          response.status
        }`
      );
    }

    const anyBody = await response.json();

    logger.debug("deliverEvent() response from endpoint", {
      body: anyBody,
    });

    return DeliverEventResponseSchema.parse(anyBody);
  }

  async executeJob(options: ExecuteJobBody) {
    const response = await safeFetch(this.#url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-api-key": this.#apiKey,
        "x-trigger-action": "EXECUTE_JOB",
      },
      body: JSON.stringify(options),
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${this.#url}`);
    }

    if (!response.ok) {
      // Attempt to parse the error message
      const anyBody = await response.json();

      const error = ErrorWithStackSchema.safeParse(anyBody);

      if (error.success) {
        throw new ClientApiError(error.data.message, error.data.stack);
      }

      throw new Error(
        `Could not connect to endpoint ${this.#url}. Status code: ${
          response.status
        }`
      );
    }

    const anyBody = await response.json();

    logger.debug("executeJob() response from endpoint", {
      body: anyBody,
    });

    return ExecuteJobResponseSchema.parse(anyBody);
  }
}

async function safeFetch(url: string, options: RequestInit) {
  try {
    return await fetch(url, options);
  } catch (error) {
    logger.debug("Error while trying to connect to endpoint", {
      url,
    });
  }
}
