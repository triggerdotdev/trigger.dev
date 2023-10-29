import {
  IntegrationConfig,
  InvokeOptions,
  JobMetadata,
  LogLevel,
  QueueOptions,
  RunNotification,
} from "@trigger.dev/core";
import { IOWithIntegrations, TriggerIntegration } from "./integrations";
import { TriggerClient } from "./triggerClient";
import type {
  EventSpecification,
  Trigger,
  TriggerContext,
  TriggerEventType,
  TriggerInvokeType,
} from "./types";
import { slugifyId } from "./utils";
import { runLocalStorage } from "./runLocalStorage";
import { Prettify } from "@trigger.dev/core";

export type JobOptions<
  TTrigger extends Trigger<EventSpecification<any>>,
  TIntegrations extends Record<string, TriggerIntegration> = {},
  TOutput extends any = any,
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
      logging for the Job. The level is inherited from the client if you omit this property. */
  logLevel?: LogLevel;
  /** Imports the specified integrations into the Job. The integrations will be available on the `io` object in the `run()` function with the same name as the key. For example:
      ```ts
      client.defineJob({
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
  /** @deprecated This property is deprecated and no longer effects the execution of the Job
   * */
  queue?: QueueOptions | string;
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
  ) => Promise<TOutput>;

  // @internal
  __internal?: boolean;
};

export type JobPayload<TJob> = TJob extends Job<Trigger<EventSpecification<infer TEvent>>, any>
  ? TEvent
  : never;

export type JobIO<TJob> = TJob extends Job<any, infer TIntegrations>
  ? IOWithIntegrations<TIntegrations>
  : never;

/** A [Job](https://trigger.dev/docs/documentation/concepts/jobs) is used to define the [Trigger](https://trigger.dev/docs/documentation/concepts/triggers), metadata, and what happens when it runs. */
export class Job<
  TTrigger extends Trigger<EventSpecification<any>>,
  TIntegrations extends Record<string, TriggerIntegration> = {},
  TOutput extends any = any,
> {
  readonly options: JobOptions<TTrigger, TIntegrations, TOutput>;

  client: TriggerClient;

  constructor(
    /** An instance of [TriggerClient](/sdk/triggerclient) that is used to send events
  to the Trigger API. */
    client: TriggerClient,
    options: JobOptions<TTrigger, TIntegrations, TOutput>
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
    return typeof this.options.enabled === "boolean" ? this.options.enabled : true;
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

  get logLevel() {
    return this.options.logLevel;
  }

  get integrations(): Record<string, IntegrationConfig> {
    return Object.keys(this.options.integrations ?? {}).reduce(
      (acc: Record<string, IntegrationConfig>, key) => {
        const integration = this.options.integrations![key];

        acc[key] = {
          id: integration.id,
          metadata: integration.metadata,
          authSource: integration.authSource,
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
      startPosition: "latest", // this is deprecated, leaving this for now to make sure newer clients work with older servers
      enabled: this.enabled,
      preprocessRuns: this.trigger.preprocessRuns,
      internal,
    };
  }

  async invoke(
    cacheKey: string,
    payload: TriggerInvokeType<TTrigger>,
    options?: InvokeOptions
  ): Promise<{ id: string }>;
  async invoke(
    payload: TriggerInvokeType<TTrigger>,
    options?: InvokeOptions
  ): Promise<{ id: string }>;
  async invoke(
    param1: string | TriggerInvokeType<TTrigger>,
    param2: TriggerInvokeType<TTrigger> | InvokeOptions | undefined = undefined,
    param3: InvokeOptions | undefined = undefined
  ): Promise<{ id: string }> {
    const runStore = runLocalStorage.getStore();

    if (typeof param1 === "string") {
      if (!runStore) {
        throw new Error(
          "Cannot invoke a job from outside of a run when passing a cacheKey. Make sure you are running the job from within a run or use the invoke method without the cacheKey."
        );
      }

      const options = param3 ?? {};

      return await runStore.io.runTask(
        param1,
        async (task) => {
          const result = await this.client.invokeJob(this.id, param2, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          });

          task.outputProperties = [
            {
              label: "Run",
              text: result.id,
              url: `/orgs/${runStore.ctx.organization.slug}/projects/${runStore.ctx.project.slug}/jobs/${this.id}/runs/${result.id}/trigger`,
            },
          ];

          return result;
        },
        {
          name: `Manually Invoke '${this.name}'`,
          params: param2,
          properties: [
            {
              label: "Job",
              text: this.id,
              url: `/orgs/${runStore.ctx.organization.slug}/projects/${runStore.ctx.project.slug}/jobs/${this.id}`,
            },
            {
              label: "Env",
              text: runStore.ctx.environment.slug,
            },
          ],
        }
      );
    }

    if (runStore) {
      throw new Error("Cannot invoke a job from within a run without a cacheKey.");
    }

    return await this.client.invokeJob(this.id, param1, param3);
  }

  async invokeAndWaitForCompletion(
    cacheKey: string | string[],
    payload: TriggerInvokeType<TTrigger>,
    timeoutInSeconds: number = 60 * 60, // 1 hour
    options: Prettify<Pick<InvokeOptions, "accountId" | "context">> = {}
  ): Promise<RunNotification<TOutput>> {
    const runStore = runLocalStorage.getStore();

    if (!runStore) {
      throw new Error(
        "Cannot invoke a job from outside of a run using invokeAndWaitForCompletion. Make sure you are running the job from within a run or use the invoke method instead."
      );
    }

    const { io, ctx } = runStore;

    return (await io.runTask(
      cacheKey,
      async (task) => {
        const parsedPayload = this.trigger.event.parseInvokePayload
          ? this.trigger.event.parseInvokePayload(payload)
            ? payload
            : undefined
          : payload;

        const result = await this.client.invokeJob(this.id, parsedPayload, {
          idempotencyKey: task.idempotencyKey,
          callbackUrl: task.callbackUrl ?? undefined,
          ...options,
        });

        task.outputProperties = [
          {
            label: "Run",
            text: result.id,
            url: `/orgs/${ctx.organization.slug}/projects/${ctx.project.slug}/jobs/${this.id}/runs/${result.id}/trigger`,
          },
        ];

        return {}; // we don't want to return anything here, we just want to wait for the callback
      },
      {
        name: `Manually Invoke '${this.name}' and wait for completion`,
        params: payload,
        properties: [
          {
            label: "Job",
            text: this.id,
            url: `/orgs/${ctx.organization.slug}/projects/${ctx.project.slug}/jobs/${this.id}`,
          },
          {
            label: "Env",
            text: ctx.environment.slug,
          },
        ],
        callback: {
          enabled: true,
          timeoutInSeconds,
        },
      }
    )) as RunNotification<TOutput>;
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
