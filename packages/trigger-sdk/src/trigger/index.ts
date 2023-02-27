import { TriggerClient } from "../client";
import { LogLevel } from "internal-bridge";
import { TriggerEvent } from "../events";
import chalk from "chalk";

import type { TriggerContext } from "../types";
import { z } from "zod";
import terminalLink from "terminal-link";

export type TriggerOptions<TSchema extends z.ZodTypeAny> = {
  id: string;
  name: string;
  on: TriggerEvent<TSchema>;
  apiKey?: string;
  endpoint?: string;
  logLevel?: LogLevel;

  /**
   * The TTL for the trigger in seconds. If the trigger is not run within this time, it will be aborted. Defaults to 3600 seconds (1 hour).
   * @type {number}
   */
  triggerTTL?: number;

  run: (event: z.infer<TSchema>, ctx: TriggerContext) => Promise<any>;
};

export class Trigger<TSchema extends z.ZodTypeAny> {
  options: TriggerOptions<TSchema>;
  #client: TriggerClient<TSchema> | undefined;

  constructor(options: TriggerOptions<TSchema>) {
    this.options = options;
  }

  async listen() {
    const apiKey = this.#getApiKey();

    if (apiKey.status === "invalid") {
      console.log(
        `${chalk.red("Trigger.dev error")}: ${chalk.bold(
          this.id
        )} is has an invalid API key ("${chalk.italic(
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

      return;
    } else if (apiKey.status === "missing") {
      console.log(
        `${chalk.red("Trigger.dev error")}: ${chalk.bold(
          this.id
        )} is missing an API key, please set the TRIGGER_API_KEY environment variable or pass the apiKey option to the Trigger constructor. ${terminalLink(
          "Get your API key here",
          "https://app.trigger.dev",
          {
            fallback(text, url) {
              return `${text} 👉 ${url}`;
            },
          }
        )}`
      );

      return;
    }

    if (!this.#client) {
      this.#client = new TriggerClient(this, this.options);
    }

    return this.#client.listen();
  }

  get id() {
    return this.options.id;
  }

  get name() {
    return this.options.name;
  }

  get endpoint() {
    return this.options.endpoint;
  }

  get on() {
    return this.options.on;
  }

  #getApiKey() {
    const apiKey = this.options.apiKey ?? process.env.TRIGGER_API_KEY;

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
}
