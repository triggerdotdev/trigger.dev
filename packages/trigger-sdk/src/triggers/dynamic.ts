import {
  RegisterSourceEventV2,
  RegisterTriggerBodyV2,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/core";
import { Job } from "../job.js";
import { TriggerClient } from "../triggerClient.js";
import { EventSpecification, Trigger } from "../types.js";
import { slugifyId } from "../utils.js";
import { ExternalSource, ExternalSourceParams } from "./externalSource.js";
import { runLocalStorage } from "../runLocalStorage.js";
import { EventFilter } from "@trigger.dev/core";

/** Options for a DynamicTrigger  */
export type DynamicTriggerOptions<
  TEventSpec extends EventSpecification<any>,
  TExternalSource extends ExternalSource<any, any, any>,
> = {
  /** Used to uniquely identify a DynamicTrigger */
  id: string;
  /** An event from an [Integration](https://trigger.dev/docs/integrations) package that you want to attach to the DynamicTrigger. The event types will come through to the payload in your Job's run. */
  event: TEventSpec;
  /** An external source fron an [Integration](https://trigger.dev/docs/integrations) package
   * @example 
   * ```ts
   *  import { events } from "@trigger.dev/github";
   * 
   *  const dynamicOnIssueOpened = client.defineDynamicTrigger({
        id: "github-issue-opened",
        event: events.onIssueOpened,
        source: github.sources.repo,
      });
   * ```
    */
  source: TExternalSource;
};

/** `DynamicTrigger` allows you to define a trigger that can be configured dynamically at runtime. */
export class DynamicTrigger<
  TEventSpec extends EventSpecification<any>,
  TExternalSource extends ExternalSource<any, any, any>,
> implements Trigger<TEventSpec>
{
  #client: TriggerClient;
  #options: DynamicTriggerOptions<TEventSpec, TExternalSource>;
  source: TExternalSource;

  /** `DynamicTrigger` allows you to define a trigger that can be configured dynamically at runtime.
   * @param client The `TriggerClient` instance to use for registering the trigger.
   * @param options The options for the dynamic trigger.
   * */
  constructor(client: TriggerClient, options: DynamicTriggerOptions<TEventSpec, TExternalSource>) {
    this.#client = client;
    this.#options = options;
    this.source = options.source;

    client.attachDynamicTrigger(this);
  }

  toJSON(): TriggerMetadata {
    return {
      type: "dynamic",
      id: this.#options.id,
    };
  }

  get id() {
    return this.#options.id;
  }

  get event() {
    return this.#options.event;
  }

  // @internal
  registeredTriggerForParams(
    params: ExternalSourceParams<TExternalSource>,
    options: { accountId?: string; filter?: EventFilter } = {}
  ): RegisterTriggerBodyV2 {
    const key = slugifyId(this.source.key(params));

    return {
      rule: {
        event: this.event.name,
        source: this.event.source,
        payload: deepMergeFilters(
          this.source.filter(params),
          this.event.filter ?? {},
          options.filter ?? {}
        ),
      },
      source: {
        version: "2",
        key,
        channel: this.source.channel,
        params,
        //todo add other options here
        options: {
          event: typeof this.event.name === "string" ? [this.event.name] : this.event.name,
        },
        integration: {
          id: this.source.integration.id,
          metadata: this.source.integration.metadata,
          authSource: this.source.integration.authSource,
        },
      },
      accountId: options.accountId,
    };
  }

  /** Use this method to register a new configuration with the DynamicTrigger.
   * @param key The key for the configuration. This will be used to identify the configuration when it is triggered.
   * @param params The params for the configuration.
   * @param options Options for the configuration.
   * @param options.accountId The accountId to associate with the configuration.
   * @param options.filter The filter to use for the configuration.
   *
   */
  async register(
    key: string,
    params: ExternalSourceParams<TExternalSource>,
    options: { accountId?: string; filter?: EventFilter } = {}
  ): Promise<RegisterSourceEventV2> {
    const runStore = runLocalStorage.getStore();

    if (!runStore) {
      return this.#client.registerTrigger(
        this.id,
        key,
        this.registeredTriggerForParams(params, options)
      );
    }

    const { io } = runStore;

    return await io.runTask(
      [key, "register"],
      async (task) => {
        return this.#client.registerTrigger(
          this.id,
          key,
          this.registeredTriggerForParams(params, options),
          task.idempotencyKey
        );
      },
      {
        name: "Register Dynamic Trigger",
        properties: [
          { label: "Dynamic Trigger ID", text: this.id },
          { label: "ID", text: key },
        ],
        params: params as any,
      }
    );
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpec>, any>): void {
    triggerClient.attachJobToDynamicTrigger(job, this);
  }

  get preprocessRuns() {
    return true;
  }

  async verifyPayload(payload: ReturnType<TEventSpec["parsePayload"]>) {
    return { success: true as const };
  }
}
