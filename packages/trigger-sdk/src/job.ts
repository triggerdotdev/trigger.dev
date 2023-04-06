import { LogLevel } from "@trigger.dev/internal";
import { Connection, IOWithConnections } from "./connections";
import { TriggerClient } from "./triggerClient";
import { Trigger } from "./triggers";
import type { TriggerContext } from "./types";

export type JobOptions<
  TEventType extends object = {},
  TConnections extends Record<string, Connection<any, any, any>> = {}
> = {
  id: string;
  name: string;
  version: string;
  trigger: Trigger<TEventType>;
  logLevel?: LogLevel;
  connections?: TConnections;

  run: (
    event: TEventType,
    io: IOWithConnections<TConnections>,
    ctx: TriggerContext
  ) => Promise<any>;
};

export class Job<
  TEventType extends object,
  TConnections extends Record<string, Connection<any, any, any>>
> {
  readonly options: JobOptions<TEventType, TConnections>;

  constructor(options: JobOptions<TEventType, TConnections>) {
    this.options = options;
    this.#validate();
  }

  get id() {
    return this.options.id;
  }

  get name() {
    return this.options.name;
  }

  get trigger() {
    return this.options.trigger;
  }

  get version() {
    return this.options.version;
  }

  get connections() {
    return Object.keys(this.options.connections ?? {}).map((key) => {
      return { key, metadata: this.options.connections![key].metadata };
    });
  }

  registerWith(client: TriggerClient) {
    client.register(this as unknown as Job<{}, any>);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      trigger: this.trigger.toJSON(),
      connections: this.connections,
    };
  }

  // Make sure the id is valid (must only contain alphanumeric characters and dashes)
  // Make sure the version is valid (must be a valid semver version)
  #validate() {
    if (!this.id.match(/^[a-zA-Z0-9-]+$/)) {
      throw new Error(
        `Invalid job id: "${this.id}". Job ids must only contain alphanumeric characters and dashes.`
      );
    }

    if (!this.version.match(/^(\d+)\.(\d+)\.(\d+)$/)) {
      throw new Error(
        `Invalid job version: "${this.version}". Job versions must be valid semver versions.`
      );
    }
  }
}
