import { TriggerClient } from "../client";
import { LogLevel } from "internal-bridge";
import { TriggerEvent } from "../events";

import type { TriggerContext } from "../types";
import { z } from "zod";

export type TriggerOptions<TSchema extends z.ZodTypeAny> = {
  id: string;
  name: string;
  on: TriggerEvent<TSchema>;
  apiKey?: string;
  endpoint?: string;
  logLevel?: LogLevel;
  run: (event: z.infer<TSchema>, ctx: TriggerContext) => Promise<any>;
};

export class Trigger<TSchema extends z.ZodTypeAny> {
  options: TriggerOptions<TSchema>;
  #client: TriggerClient<TSchema> | undefined;

  constructor(options: TriggerOptions<TSchema>) {
    this.options = options;
  }

  async listen() {
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
}
