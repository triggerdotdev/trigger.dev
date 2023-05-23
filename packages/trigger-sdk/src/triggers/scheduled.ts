import { z } from "zod";
import { EventSpecification } from "../types";
import { Trigger } from "../types";
import { TriggerClient } from "../triggerClient";
import { Job } from "../job";
import {
  CronOptions,
  IntervalOptions,
  ScheduledPayload,
  ScheduledPayloadSchema,
  TriggerMetadata,
} from "@trigger.dev/internal";

type ScheduledEventSpecification = EventSpecification<ScheduledPayload>;

export class IntervalTrigger implements Trigger<ScheduledEventSpecification> {
  constructor(private options: IntervalOptions) {}

  get event() {
    return {
      name: "trigger.scheduled",
      title: "Schedule",
      source: "trigger.dev",
      parsePayload: ScheduledPayloadSchema.parse,
      elements: [
        {
          label: "Interval",
          text: `${this.options.seconds}s`,
        },
      ],
    };
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<ScheduledEventSpecification>, any>
  ): void {}

  toJSON(): Array<TriggerMetadata> {
    return [
      {
        type: "scheduled",
        schedule: {
          type: "interval",
          options: {
            seconds: this.options.seconds,
          },
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

export class CronTrigger implements Trigger<ScheduledEventSpecification> {
  constructor(private options: CronOptions) {}

  get event() {
    return {
      name: "trigger.scheduled",
      title: "Cron Schedule",
      source: "trigger.dev",
      parsePayload: ScheduledPayloadSchema.parse,
      elements: [
        {
          label: "Expression",
          text: this.options.cron,
        },
      ],
    };
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<ScheduledEventSpecification>, any>
  ): void {}

  toJSON(): Array<TriggerMetadata> {
    return [
      {
        type: "scheduled",
        schedule: {
          type: "cron",
          options: {
            cron: this.options.cron,
          },
        },
      },
    ];
  }

  get requiresPreparaton(): boolean {
    return false;
  }
}

export function cronTrigger(options: CronOptions) {
  return new CronTrigger(options);
}

export type DynamicIntervalOptions = { id: string };

export class DynamicInterval implements Trigger<ScheduledEventSpecification> {
  constructor(
    private client: TriggerClient,
    private options: DynamicIntervalOptions
  ) {}

  get event() {
    return {
      name: "trigger.scheduled",
      title: "Dynamic Schedule",
      source: "trigger.dev",
      parsePayload: ScheduledPayloadSchema.parse,
    };
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<ScheduledEventSpecification>, any>
  ): void {
    triggerClient.attachDynamicSchedule(this.options.id, job);
  }

  toJSON(): Array<TriggerMetadata> {
    return [
      {
        type: "dynamic",
        id: this.options.id,
      },
    ];
  }

  get requiresPreparaton(): boolean {
    return false;
  }
}
