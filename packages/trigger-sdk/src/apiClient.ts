import type {
  ApiEventLog,
  CompleteTaskBodyInput,
  CreateExecutionBody,
  LogMessage,
  RunTaskBodyInput,
  SendEvent,
  SendEventOptions,
  ServerTask,
} from "@trigger.dev/internal";
import { Logger, LogLevel } from "@trigger.dev/internal";

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

export type ExecutionRecord = {
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

  async registerHttpSource(options: {
    key: string;
    managed: boolean;
  }): Promise<HttpSourceRecord> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Registering http source", {
      options,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/sources/http`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(options),
    });

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

  async activateHttpSource(
    id: string,
    options: {
      secret: string;
      data?: any;
    }
  ): Promise<HttpSourceRecord> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Activating http source", {
      options,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/sources/http/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(options),
    });

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

  async createExecution(params: CreateExecutionBody): Promise<{ id: string }> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Creating execution", {
      params,
    });

    const response = await fetch(`${this.#apiUrl}/api/v3/executions`, {
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
        `Failed to create execution, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async createLog(executionId: string, logMessage: LogMessage) {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Creating log", {
      executionId,
      logMessage,
    });

    const response = await fetch(
      `${this.#apiUrl}/api/v3/executions/${executionId}/logs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(logMessage),
      }
    );

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();

      throw new Error(body.error);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to create execution, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async runTask(
    executionId: string,
    task: RunTaskBodyInput
  ): Promise<ServerTask> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Running Task", {
      task,
    });

    const response = await fetch(
      `${this.#apiUrl}/api/v3/executions/${executionId}/tasks`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": task.idempotencyKey,
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
        `Failed to create execution, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async completeTask(
    executionId: string,
    id: string,
    task: CompleteTaskBodyInput
  ): Promise<ServerTask> {
    const apiKey = await this.#apiKey();

    this.#logger.debug("Complete Task", {
      task,
    });

    const response = await fetch(
      `${this.#apiUrl}/api/v3/executions/${executionId}/tasks/${id}/complete`,
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
        `Failed to create execution, got status code ${response.status}`
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
        `Failed to create execution, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async #apiKey() {
    const apiKey = getApiKey(this.#options.apiKey);

    if (apiKey.status === "invalid") {
      const chalk = (await import("chalk")).default;
      const terminalLink = (await import("terminal-link")).default;

      throw new Error(
        `${chalk.red("Trigger.dev error")}: Invalid API key ("${chalk.italic(
          apiKey.apiKey
        )}"), please set the TRIGGER_API_KEY environment variable or pass the apiKey option to a valid value. ${terminalLink(
          "Get your API key here",
          "https://app.trigger.dev",
          {
            fallback(text, url) {
              return `${text} 👉 ${url}`;
            },
          }
        )}`
      );
    } else if (apiKey.status === "missing") {
      const chalk = (await import("chalk")).default;
      const terminalLink = (await import("terminal-link")).default;

      throw new Error(
        `${chalk.red(
          "Trigger.dev error"
        )}: Missing an API key, please set the TRIGGER_API_KEY environment variable or pass the apiKey option to the Trigger constructor. ${terminalLink(
          "Get your API key here",
          "https://app.trigger.dev",
          {
            fallback(text, url) {
              return `${text} 👉 ${url}`;
            },
          }
        )}`
      );
    }

    return apiKey.apiKey;
  }
}

function getApiKey(key?: string) {
  const apiKey = key ?? process.env.TRIGGER_API_KEY;

  if (!apiKey) {
    return { status: "missing" as const };
  }

  // Validate the api_key format (should be trigger_{env}_XXXXX)
  const isValid = apiKey.match(/^trigger_[a-z]+_[a-zA-Z0-9]+$/);

  if (!isValid) {
    return { status: "invalid" as const, apiKey };
  }

  return { status: "valid" as const, apiKey };
}
