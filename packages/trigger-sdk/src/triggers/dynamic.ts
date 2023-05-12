import { TriggerMetadata } from "@trigger.dev/internal";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";
import { ExternalSource, ExternalSourceParams } from "./externalSource";

export type DynamicTriggerOptions<
  TEventSpec extends EventSpecification<any>,
  TExternalSource extends ExternalSource<any, any, any>
> = {
  id: string;
  event: TEventSpec;
  source?: TExternalSource;
};

export class DynamicTrigger<
  TEventSpec extends EventSpecification<any>,
  TExternalSource extends ExternalSource<any, any, any>
> implements Trigger<TEventSpec>
{
  #client: TriggerClient;
  #options: DynamicTriggerOptions<TEventSpec, TExternalSource>;

  constructor(
    client: TriggerClient,
    options: DynamicTriggerOptions<TEventSpec, TExternalSource>
  ) {
    this.#client = client;
    this.#options = options;
  }

  toJSON(): Array<TriggerMetadata> {
    return [
      {
        type: "dynamic",
        id: this.#options.id,
      },
    ];
  }

  get event() {
    return this.#options.event;
  }

  // Just an example for the types
  register(params: ExternalSourceParams<TExternalSource>): void {}

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpec>, any>
  ): void {}
}
