import {
  ApiEventLog,
  CompleteTaskBodyInput,
  CreateRunBody,
  CreateRunResponseBodySchema,
  HttpEventSource,
  LogLevel,
  LogMessage,
  Logger,
  RegisterHttpEventSourceBody,
  RunTaskBodyInput,
  SendEvent,
  SendEventOptions,
  ServerTask,
  TriggerVariantResponseBody,
  TriggerVariantConfig,
  TriggerVariantResponseBodySchema,
  UpdateHttpEventSourceBody,
} from "@trigger.dev/internal";

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

    this.#apiUrl =
      this.#options.apiUrl ??
      process.env.TRIGGER_API_URL ??
      "https://api.trigger.dev";
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);
  }

  async registerEndpoint(options: {
    url: string;
    name: string;
  }): Promise<EndpointRecord> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Registering endpoint", {
      url: options.url,
      name: options.name,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/endpoints`, {
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
      throw new Error(
        `Failed to register entry point, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async createRun(params: CreateRunBody) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Creating run", {
      params,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(params),
    });

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to create run, got status code ${response.status}`
      );
    }

    const body = await response.json();

    return CreateRunResponseBodySchema.parse(body);
  }

  async createLog(runId: string, logMessage: LogMessage) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Creating log", {
      runId,
      logMessage,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/runs/${runId}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(logMessage),
    });

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to create run log, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async runTask(runId: string, task: RunTaskBodyInput): Promise<ServerTask> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Running Task", {
      task,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/runs/${runId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": task.idempotencyKey,
      },
      body: JSON.stringify(task),
    });

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(`Failed to run task, got status code ${response.status}`);
    }

    return await response.json();
  }

  async completeTask(
    runId: string,
    id: string,
    task: CompleteTaskBodyInput
  ): Promise<ServerTask> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Complete Task", {
      task,
    });

    const response = await fetch(
      `${this.#apiUrl}/api/v3/runs/${runId}/tasks/${id}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(task),
      }
    );

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to complete task, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async sendEvent(
    event: SendEvent,
    options: SendEventOptions = {}
  ): Promise<ApiEventLog> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Sending event", {
      event,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ event, options }),
    });

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to send event, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async addTriggerVariant(
    client: string,
    jobId: string,
    jobVersion: string,
    config: TriggerVariantConfig
  ): Promise<TriggerVariantResponseBody> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Adding Trigger Variant", {
      client,
      jobId,
      jobVersion,
      config,
    });

    const response = await fetch(
      `${this.#apiUrl}/api/v3/${client}/jobs/${jobId}/${jobVersion}/variants`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(config),
      }
    );

    if (response.status === 404) {
      throw new Error(
        `Failed to add trigger variant, got status code ${response.status}`
      );
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to add trigger variant, got status code ${response.status}`
      );
    }

    const anyBody = await response.json();

    return TriggerVariantResponseBodySchema.parse(anyBody);
  }

  async registerHttpSource(
    client: string,
    source: RegisterHttpEventSourceBody
  ): Promise<HttpEventSource> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Initializing http source", {
      source,
    });

    const response = await fetch(
      `${this.#apiUrl}/api/v3/${client}/sources/http`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(source),
      }
    );

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to register http source, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async updateHttpSource(
    client: string,
    id: string,
    source: UpdateHttpEventSourceBody
  ): Promise<HttpEventSource> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("activating http source", {
      source,
    });

    const response = await fetch(
      `${this.#apiUrl}/api/v3/${client}/sources/http/${id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(source),
      }
    );

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to activate http source, got status code ${response.status}`
      );
    }

    return await response.json();
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
