import {
  IntegrationConfig,
  JobMetadata,
  LogLevel,
  QueueOptions,
} from "@trigger.dev/internal";
import {
  IOWithIntegrations,
  IntegrationClient,
  TriggerIntegration,
} from "./integrations";
import { TriggerClient } from "./triggerClient";
import type {
  EventSpecification,
  Trigger,
  TriggerContext,
  TriggerEventType,
} from "./types";
import { slugifyId } from "./utils";

export type JobOptions<
  TTrigger extends Trigger<EventSpecification<any>>,
  TIntegrations extends Record<
    string,
    TriggerIntegration<IntegrationClient<any, any>>
  > = {}
> = {
  id: string;
  name: string;
  version: string;
  trigger: TTrigger;
  logLevel?: LogLevel;
  integrations?: TIntegrations;
  queue?: QueueOptions | string;
  startPosition?: "initial" | "latest";
  enabled?: boolean;

  run: (
    event: TriggerEventType<TTrigger>,
    io: IOWithIntegrations<TIntegrations>,
    ctx: TriggerContext
  ) => Promise<any>;
};

export class Job<
  TTrigger extends Trigger<EventSpecification<any>>,
  TIntegrations extends Record<
    string,
    TriggerIntegration<IntegrationClient<any, any>>
  > = {}
> {
  readonly options: JobOptions<TTrigger, TIntegrations>;

  client: TriggerClient;

  constructor(
    client: TriggerClient,
    options: JobOptions<TTrigger, TIntegrations>
  ) {
    this.client = client;
    this.options = options;
    this.#validate();

    client.attach(this);
  }

  get id() {
    return slugifyId(this.options.id);
  }

  get enabled() {
    return typeof this.options.enabled === "boolean"
      ? this.options.enabled
      : true;
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

  get integrations(): Record<string, IntegrationConfig> {
    return Object.keys(this.options.integrations ?? {}).reduce(
      (acc: Record<string, IntegrationConfig>, key) => {
        const integration = this.options.integrations![key];

        acc[key] = {
          id: integration.id,
          metadata: integration.metadata,
          authSource: integration.client.usesLocalAuth ? "LOCAL" : "HOSTED",
        };

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
      trigger: this.trigger.toJSON(),
      integrations: this.integrations,
      queue: this.options.queue,
      startPosition: this.options.startPosition ?? "latest",
      enabled:
        typeof this.options.enabled === "boolean" ? this.options.enabled : true,
      preprocessRuns: this.trigger.preprocessRuns,
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
