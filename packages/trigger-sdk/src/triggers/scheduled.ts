import {
  CronOptions,
  IntervalOptions,
  ScheduleMetadata,
  ScheduledPayload,
  ScheduledPayloadSchema,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";

type ScheduledEventSpecification = EventSpecification<ScheduledPayload>;

export class IntervalTrigger implements Trigger<ScheduledEventSpecification> {
  constructor(private options: IntervalOptions) {}

  get event() {
    return {
      name: "trigger.scheduled",
      title: "Schedule",
      source: "trigger.dev",
      icon: "schedule-interval",
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

  get preprocessRuns() {
    return false;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "scheduled",
      schedule: {
        type: "interval",
        options: {
          seconds: this.options.seconds,
        },
      },
    };
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
      icon: "schedule-cron",
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

  get preprocessRuns() {
    return false;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "scheduled",
      schedule: {
        type: "cron",
        options: {
          cron: this.options.cron,
        },
      },
    };
  }
}

export function cronTrigger(options: CronOptions) {
  return new CronTrigger(options);
}

export type DynamicIntervalOptions = { id: string };

export class DynamicSchedule implements Trigger<ScheduledEventSpecification> {
  constructor(
    private client: TriggerClient,
    private options: DynamicIntervalOptions
  ) {}

  get id() {
    return this.options.id;
  }

  get event() {
    return {
      name: "trigger.scheduled",
      title: "Dynamic Schedule",
      source: "trigger.dev",
      icon: "schedule-dynamic",
      parsePayload: ScheduledPayloadSchema.parse,
    };
  }

  async register(key: string, metadata: ScheduleMetadata) {
    return this.client.registerSchedule(this.id, key, metadata);
  }

  async unregister(key: string) {
    return this.client.unregisterSchedule(this.id, key);
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<ScheduledEventSpecification>, any>
  ): void {
    triggerClient.attachDynamicSchedule(this.options.id, job);
  }

  get preprocessRuns() {
    return false;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "dynamic",
      id: this.options.id,
    };
  }
}
