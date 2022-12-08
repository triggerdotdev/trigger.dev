import { TriggerClient } from "./client";
import { LogLevel } from "internal-bridge";
import { Trigger } from "./triggers";

export type WorkflowOptions<TEventData = void> = {
  id: string;
  name: string;
  apiKey?: string;
  endpoint?: string;
  logLevel?: LogLevel;
  trigger: Trigger<TEventData>;
  run: (event: TEventData) => Promise<void>;
};

export class Workflow<TEventData = void> {
  options: WorkflowOptions<TEventData>;
  #client: TriggerClient<TEventData> | undefined;

  constructor(options: WorkflowOptions<TEventData>) {
    this.options = options;
  }

  async listen() {
    if (!this.#client) {
      this.#client = new TriggerClient(this, this.options);
    }

    return this.#client.listen();
  }

  private async run(trigger: Trigger<TEventData>) {
    // return this.options.run(trigger.event);
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
