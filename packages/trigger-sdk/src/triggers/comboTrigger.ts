import { TriggerMetadata } from "@trigger.dev/internal";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";

type ComboTriggerOptions<
  TEventSpecification extends EventSpecification<any>,
  TTriggers extends Array<Trigger<TEventSpecification>>
> = {
  event: TEventSpecification;
  triggers: TTriggers;
};

class ComboTrigger<
  TEventSpecification extends EventSpecification<any>,
  TTriggers extends Array<Trigger<TEventSpecification>>
> implements Trigger<TEventSpecification>
{
  #options: ComboTriggerOptions<TEventSpecification, TTriggers>;

  constructor(options: ComboTriggerOptions<TEventSpecification, TTriggers>) {
    this.#options = options;
  }

  toJSON(): Array<TriggerMetadata> {
    return this.#options.triggers.flatMap((trigger) => trigger.toJSON());
  }

  get event() {
    return this.#options.event;
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpecification>, any>
  ): void {}
}

export function comboTrigger<
  TEventSpecification extends EventSpecification<any>,
  TTriggers extends Array<Trigger<TEventSpecification>>
>(
  options: ComboTriggerOptions<TEventSpecification, TTriggers>
): Trigger<TEventSpecification> {
  return new ComboTrigger(options);
}
