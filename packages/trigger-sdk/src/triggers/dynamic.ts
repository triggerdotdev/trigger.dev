import {
  RegisterSourceEvent,
  RegisterTriggerBody,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/internal";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";
import { slugifyId } from "../utils";
import { ExternalSource, ExternalSourceParams } from "./externalSource";

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

  registeredTriggerForParams(
    params: ExternalSourceParams<TExternalSource>
  ): RegisterTriggerBody {
    return {
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
        integration: {
          id: this.source.integration.id,
          metadata: this.source.integration.metadata,
          authSource: this.source.integration.client.usesLocalAuth
            ? "LOCAL"
            : "HOSTED",
        },
      },
    };
  }

  async register(
    key: string,
    params: ExternalSourceParams<TExternalSource>
  ): Promise<RegisterSourceEvent> {
    return this.#client.registerTrigger(
      this.id,
      key,
      this.registeredTriggerForParams(params)
    );
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpec>, any>
  ): void {
    triggerClient.attachJobToDynamicTrigger(job, this);
  }

  get preprocessRuns() {
    return true;
  }
}
