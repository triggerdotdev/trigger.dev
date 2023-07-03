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
  Logger,
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
  /** The `id` property is used to uniquely identify the Job. Only change this if you want to create a new Job. */
  id: string;
  /** The `name` of the Job that you want to appear in the dashboard and logs. You can change this without creating a new Job. */
  name: string;
  /** The `version` property is used to version your Job. A new version will be created if you change this property. We recommend using [semantic versioning](https://www.baeldung.com/cs/semantic-versioning), e.g. `1.0.3`. */
  version: string;
  /** The `trigger` property is used to define when the Job should run. There are currently the following Trigger types:
      - [cronTrigger](https://trigger.dev/docs/sdk/crontrigger)
      - [intervalTrigger](https://trigger.dev/docs/sdk/intervaltrigger)
      - [eventTrigger](https://trigger.dev/docs/sdk/eventtrigger)
      - [DynamicTrigger](https://trigger.dev/docs/sdk/dynamictrigger)
      - [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule)
      - integration Triggers, like webhooks. See the [integrations](https://trigger.dev/docs/integrations) page for more information. */
  trigger: TTrigger;
  /** The `logLevel` property is an optional property that specifies the level of
      logging for the Job. The level is inherited from the client if you omit this property. It can have one of the following values:
      - `log` - logs only essential messages
      - `error` - logs error messages
      - `warn` - logs errors and warning messages
      - `info` - logs errors, warnings and info messages
      - `debug` - logs everything with full verbosity */
  logLevel?: LogLevel;
  /** Imports the specified integrations into the Job. The integrations will be available on the `io` object in the `run()` function with the same name as the key. For example:
      ```ts
      new Job(client, {
        //... other options
        integrations: {
          slack,
          gh: github,
        },
        run: async (payload, io, ctx) => {
          //slack is available on io.slack
          io.slack.postMessage(...);
          //github is available on io.gh
          io.gh.addIssueLabels(...);
        }
      });
      ``` */
  integrations?: TIntegrations;
  /** The `queue` property is used to specify a custom queue. If you use an Object and specify the `maxConcurrent` option, you can control how many simulataneous runs can happen. */
  queue?: QueueOptions | string;
  startPosition?: "initial" | "latest";
  /** The `enabled` property is used to enable or disable the Job. If you disable a Job, it will not run. */
  enabled?: boolean;
  /** This function gets called automatically when a Run is Triggered.
   * This is where you put the code you want to run for a Job. You can use normal code in here and you can also use Tasks. You can return a value from this function and it will be sent back to the Trigger API.
   * @param payload The payload of the event
   * @param io An object that contains the integrations that you specified in the `integrations` property and other useful functions like delays and running Tasks.
   * @param context An object that contains information about the Organization, Job, Run and more.
   */
  run: (
    payload: TriggerEventType<TTrigger>,
    io: IOWithIntegrations<TIntegrations>,
    context: TriggerContext
  ) => Promise<any>;
};

/** A [Job](https://trigger.dev/docs/documentation/concepts/jobs) is used to define the [Trigger](https://trigger.dev/docs/documentation/concepts/triggers), metadata, and what happens when it runs. */
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
    /** An instance of [TriggerClient](/sdk/triggerclient) that is used to send events
  to the Trigger API. */
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

  get logLevel() {
    return this.options.logLevel;
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
