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
    if (this.#isMissingApiKey) {
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

  get #isMissingApiKey() {
    return !this.options.apiKey && !process.env.TRIGGER_API_KEY;
  }
}
