import {
  RegisterSourceEvent,
  RegisterTriggerBody,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/core";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";
import { slugifyId } from "../utils";
import { ExternalSource, ExternalSourceParams } from "./externalSource";

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
   *  const dynamicOnIssueOpened = new DynamicTrigger(client, {
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

  registeredTriggerForParams(params: ExternalSourceParams<TExternalSource>): RegisterTriggerBody {
    const key = slugifyId(this.source.key(params));

    return {
      rule: {
        event: this.event.name,
        source: this.event.source,
        payload: deepMergeFilters(this.source.filter(params), this.event.filter ?? {}),
      },
      source: {
        key,
        channel: this.source.channel,
        params,
        events: typeof this.event.name === "string" ? [this.event.name] : this.event.name,
        integration: {
          id: this.source.integration.id,
          metadata: this.source.integration.metadata,
          authSource: this.source.integration.authSource,
        },
      },
    };
  }

  /** Use this method to register a new configuration with the DynamicTrigger.
   * @param key The key for the configuration. This will be used to identify the configuration when it is triggered.
   * @param params The params for the configuration.
   */
  async register(
    key: string,
    params: ExternalSourceParams<TExternalSource>
  ): Promise<RegisterSourceEvent> {
    return this.#client.registerTrigger(this.id, key, this.registeredTriggerForParams(params));
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpec>, any>): void {
    triggerClient.attachJobToDynamicTrigger(job, this);
  }

  get preprocessRuns() {
    return true;
  }
}
