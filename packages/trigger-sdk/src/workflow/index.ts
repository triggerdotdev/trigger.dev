import { TriggerClient } from "../client";
import { LogLevel } from "internal-bridge";
import { Trigger } from "../triggers";

type RecordToObject<U, T extends Record<string, U>> = {
  [K in keyof T]: T[K];
};

export type WorkflowOptions<
  TEventData,
  TConnectionType,
  TConnections extends Record<string, TConnectionType>
> = {
  id: string;
  name: string;
  apiKey?: string;
  endpoint?: string;
  logLevel?: LogLevel;
  trigger: Trigger<TEventData>;
  connections?: TConnections;
  run: (
    event: TEventData,
    lib: RecordToObject<TConnectionType, TConnections>
  ) => Promise<void>;
};

export class Workflow<
  TEventData,
  TConnectionType,
  TConnections extends Record<string, TConnectionType>
> {
  options: WorkflowOptions<TEventData, TConnectionType, TConnections>;
  #client: TriggerClient<TEventData, TConnectionType, TConnections> | undefined;

  constructor(
    options: WorkflowOptions<TEventData, TConnectionType, TConnections>
  ) {
    this.options = options;
  }

  async listen() {
    if (!this.#client) {
      this.#client = new TriggerClient(this, this.options);
    }

    return this.#client.listen();
  }

  private async run(trigger: Trigger<TEventData>) {
    return this.options.run({} as TEventData, this.lib);
  }

  private get lib(): RecordToObject<TConnectionType, TConnections> {
    return this.options.connections as RecordToObject<
      TConnectionType,
      TConnections
    >;
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
