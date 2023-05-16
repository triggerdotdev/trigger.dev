import {
  ConnectionConfig,
  JobMetadata,
  LogLevel,
  QueueOptions,
} from "@trigger.dev/internal";
import { Connection, IOWithConnections } from "./connections";
import { TriggerClient } from "./triggerClient";
import type {
  TriggerContext,
  Trigger,
  TriggerEventType,
  EventSpecification,
} from "./types";
import { slugifyId } from "./utils";

export type JobOptions<
  TTrigger extends Trigger<EventSpecification<any>>,
  TConnections extends Record<string, Connection<any, any>> = {}
> = {
  id: string;
  name: string;
  version: string;
  trigger: TTrigger;
  logLevel?: LogLevel;
  connections?: TConnections;
  queue?: QueueOptions | string;
  startPosition?: "initial" | "latest";

  run: (
    event: TriggerEventType<TTrigger>,
    io: IOWithConnections<TConnections>,
    ctx: TriggerContext
  ) => Promise<any>;
};

export class Job<
  TTrigger extends Trigger<EventSpecification<any>>,
  TConnections extends Record<string, Connection<any, any>>
> {
  readonly options: JobOptions<TTrigger, TConnections>;

  client: TriggerClient;

  constructor(
    client: TriggerClient,
    options: JobOptions<TTrigger, TConnections>
  ) {
    this.client = client;
    this.options = options;
    this.#validate();

    client.attach(this);
  }

  get id() {
    return slugifyId(this.options.id);
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

        if (!connection.usesLocalAuth) {
          acc[key] = {
            metadata: connection.metadata,
            id: connection.id!,
          };
        }

        return acc;
      },
      {}
    );
  }

  toJSON(): JobMetadata {
    // @ts-ignore
    const internal = this.options.__internal as JobMetadata["internal"];

    return {
      id: this.id,
      name: this.name,
      version: this.version,
      event: this.trigger.event,
      triggers: this.trigger.toJSON(),
      connections: this.connections,
      queue: this.options.queue,
      startPosition: this.options.startPosition ?? "latest",
      internal,
    };
  }

  // Make sure the id is valid (must only contain alphanumeric characters and dashes)
  // Make sure the version is valid (must be a valid semver version)
  #validate() {
    if (!this.version.match(/^(\d+)\.(\d+)\.(\d+)$/)) {
      throw new Error(
        `Invalid job version: "${this.version}". Job versions must be valid semver versions.`
      );
    }
  }
}
