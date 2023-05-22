import { z } from "zod";
import { EventSpecification } from "../types";
import { Trigger } from "../types";
import { TriggerClient } from "../triggerClient";
import { Job } from "../job";
import {
  IntervalOptions,
  ScheduledPayload,
  ScheduledPayloadSchema,
  TriggerMetadata,
} from "@trigger.dev/internal";

const scheduledTriggerEvent: EventSpecification<ScheduledPayload> = {
  name: "trigger.scheduled",
  title: "Schedule",
  source: "trigger.dev",
  parsePayload: ScheduledPayloadSchema.parse,
};

export class IntervalTrigger implements Trigger<typeof scheduledTriggerEvent> {
  constructor(private options: IntervalOptions) {}

  get event() {
    return scheduledTriggerEvent;
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<typeof scheduledTriggerEvent>, any>
  ): void {
    triggerClient.attachSchedule(job.id, job, {
      type: "interval",
      options: this.options,
    });
  }

  toJSON(): Array<TriggerMetadata> {
    return [
      {
        type: "static",
        title: this.event.title,
        rule: {
          event: this.event.name,
          source: this.event.source,
        },
      },
    ];
  }

  get requiresPreparaton(): boolean {
    return false;
  }
}

export function intervalTrigger(options: IntervalOptions) {
  return new IntervalTrigger(options);
}
