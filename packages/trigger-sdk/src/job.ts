import {
  ConnectionConfig,
  JobMetadata,
  LogLevel,
  QueueOptions,
} from "@trigger.dev/internal";
import { Connection, IOWithConnections } from "./connections";
import { TriggerClient } from "./triggerClient";
import type { TriggerContext, Trigger, TriggerEventType } from "./types";

export type JobOptions<
  TTrigger extends Trigger<any>,
  TConnections extends Record<string, Connection<any, any>> = {}
> = {
  id: string;
  name: string;
  version: string;
  trigger: TTrigger;
  logLevel?: LogLevel;
  connections?: TConnections;
  queue?: QueueOptions | string;

  run: (
    event: TriggerEventType<TTrigger>,
    io: IOWithConnections<TConnections>,
    ctx: TriggerContext
  ) => Promise<any>;
};

export class Job<
  TTrigger extends Trigger<any>,
  TConnections extends Record<string, Connection<any, any>>
> {
  readonly options: JobOptions<TTrigger, TConnections>;

  client?: TriggerClient;

  constructor(options: JobOptions<TTrigger, TConnections>) {
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

  get connections(): Record<string, ConnectionConfig> {
    return Object.keys(this.options.connections ?? {}).reduce(
      (acc: Record<string, ConnectionConfig>, key) => {
        const connection = this.options.connections![key];

        if (connection.usesLocalAuth) {
          acc[key] = {
            auth: "local",
            metadata: connection.metadata,
          };
        } else {
          acc[key] = {
            auth: "hosted",
            metadata: connection.metadata,
            id: connection.id!,
          };
        }

        return acc;
      },
      {}
    );
  }

  attachTo(client: TriggerClient) {
    if (this.client) {
      throw new Error(
        `Job "${this.id}" has already been registered with a client.`
      );
    }

    this.client = client;

    client.attach(this);

    return this;
  }

  attachVariant(id: string, trigger: TTrigger) {
    if (!this.client) {
      throw new Error(
        `Job "${this.id}" has not been registered with a client.`
      );
    }

    this.client.attachVariant(this, id, trigger);

    return this;
  }

  toJSON(): JobMetadata {
    // @ts-ignore
    const internal = this.options.__internal as JobMetadata["internal"];

    return {
      id: this.id,
      name: this.name,
      version: this.version,
      trigger: this.trigger.toJSON(),
      connections: this.connections,
      queue: this.options.queue,
      internal,
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
