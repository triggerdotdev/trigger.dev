import { TriggerClient } from "./client";
import { Trigger } from "./trigger";

export type EntryPointOptions = {
  apiKey?: string;
  path?: string;
  baseUrl?: string;
};

export type EntryPointListenOptions = {
  url: string;
};

export class EntryPoint {
  #options: EntryPointOptions;
  #registerdTriggers: Record<string, Trigger> = {};
  #client: TriggerClient;

  constructor(options: EntryPointOptions) {
    this.#options = options;
    this.#client = new TriggerClient(this.#options);
  }

  register(trigger: Trigger) {
    this.#registerdTriggers[trigger.id] = trigger;
  }

  async listen(options: EntryPointListenOptions) {
    // Register the entry point
    const entryPoint = await this.#client.registerEntryPoint({
      url: options.url,
    });

    // Register the triggers
    for (const trigger of Object.values(this.#registerdTriggers)) {
      await this.#client.registerTrigger({
        entryPointId: entryPoint.id,
        id: trigger.id,
      });
    }
  }
}
