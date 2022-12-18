import { TriggerClient } from "../client";
import { LogLevel } from "internal-bridge";
import { Trigger } from "../triggers";

export type WorkflowOptions<TEventData = any> = {
  id: string;
  name: string;
  apiKey?: string;
  endpoint?: string;
  logLevel?: LogLevel;
  trigger: Trigger<TEventData>;
  run: (event: TEventData) => Promise<void>;
};

export class Workflow<TEventData = any> {
  options: WorkflowOptions<TEventData>;
  #client: TriggerClient | undefined;

  constructor(options: WorkflowOptions<TEventData>) {
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

  get trigger() {
    return this.options.trigger;
  }
}
