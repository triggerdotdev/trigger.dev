import {
  RegisterSourceEvent,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/internal";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";
import { ExternalSource, ExternalSourceParams } from "./externalSource";
import { slugifyId } from "../utils";

export type DynamicTriggerOptions<
  TEventSpec extends EventSpecification<any>,
  TExternalSource extends ExternalSource<any, any, any>
> = {
  id: string;
  event: TEventSpec;
  source: TExternalSource;
};

export class DynamicTrigger<
  TEventSpec extends EventSpecification<any>,
  TExternalSource extends ExternalSource<any, any, any>
> implements Trigger<TEventSpec>
{
  #client: TriggerClient;
  #options: DynamicTriggerOptions<TEventSpec, TExternalSource>;
  source: TExternalSource;

  constructor(
    client: TriggerClient,
    options: DynamicTriggerOptions<TEventSpec, TExternalSource>
  ) {
    this.#client = client;
    this.#options = options;
    this.source = options.source;

    client.attachDynamicTrigger(this);
  }

  toJSON(): Array<TriggerMetadata> {
    return [
      {
        type: "dynamic",
        id: this.#options.id,
      },
    ];
  }

  get id() {
    return this.#options.id;
  }

  get event() {
    return this.#options.event;
  }

  get requiresPreparaton(): boolean {
    return false;
  }

  async register(
    params: ExternalSourceParams<TExternalSource>
  ): Promise<RegisterSourceEvent> {
    return this.#client.registerTrigger(this.id, {
      rule: {
        event: this.event.name,
        source: this.event.source,
        payload: deepMergeFilters(
          this.source.filter(params),
          this.event.filter ?? {}
        ),
      },
      source: {
        key: slugifyId(this.source.key(params)),
        channel: this.source.channel,
        params,
        events: [this.event.name],
        clientId: !this.source.integration.usesLocalAuth
          ? this.source.integration.id
          : undefined,
      },
    });
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpec>, any>,
    index?: number
  ): void {
    triggerClient.attachJobToDynamicTrigger(job, this);
  }
}
