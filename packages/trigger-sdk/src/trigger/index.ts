import { TriggerClient } from "../client";
import { LogLevel } from "internal-bridge";
import { TriggerEvent } from "../events";

export type TriggerOptions<TEventData = void> = {
  id: string;
  name: string;
  on: TriggerEvent<TEventData>;
  apiKey?: string;
  endpoint?: string;
  logLevel?: LogLevel;
  run: (event: TEventData) => Promise<void>;
};

export class Trigger<TEventData = void> {
  options: TriggerOptions<TEventData>;
  #client: TriggerClient<TEventData> | undefined;

  constructor(options: TriggerOptions<TEventData>) {
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
