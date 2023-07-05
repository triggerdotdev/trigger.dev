import {
  CronOptions,
  IntervalOptions,
  ScheduleMetadata,
  ScheduledPayload,
  ScheduledPayloadSchema,
  TriggerMetadata,
  currentDate,
} from "@trigger.dev/internal";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";
import cronstrue from "cronstrue";

type ScheduledEventSpecification = EventSpecification<ScheduledPayload>;

const examples = [
  {
    id: "now",
    name: "Now",
    icon: "clock",
    payload: {
      ts: currentDate.marker,
      lastTimestamp: currentDate.marker,
    },
  },
];

export class IntervalTrigger implements Trigger<ScheduledEventSpecification> {
  constructor(private options: IntervalOptions) {}

  get event() {
    return {
      name: "trigger.scheduled",
      title: "Schedule",
      source: "trigger.dev",
      icon: "schedule-interval",
      examples,
      parsePayload: ScheduledPayloadSchema.parse,
      properties: [
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

/** `intervalTrigger()` is set as a [Job's trigger](/sdk/job) to trigger a Job at a recurring interval.
 * @param options An object containing options about the interval.
 */
export function intervalTrigger(options: IntervalOptions) {
  return new IntervalTrigger(options);
}

export class CronTrigger implements Trigger<ScheduledEventSpecification> {
  constructor(private options: CronOptions) {}

  get event() {
    const humanReadable = cronstrue.toString(this.options.cron, {
      throwExceptionOnParseError: false,
    });

    return {
      name: "trigger.scheduled",
      title: "Cron Schedule",
      source: "trigger.dev",
      icon: "schedule-cron",
      examples,
      parsePayload: ScheduledPayloadSchema.parse,
      properties: [
        {
          label: "cron",
          text: this.options.cron,
        },
        {
          label: "Schedule",
          text: humanReadable,
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

/** `cronTrigger()` is set as a [Job's trigger](https://trigger.dev/docs/sdk/job) to trigger a Job on a recurring schedule using a CRON expression.
 * @param options An object containing options about the CRON schedule.
 */
export function cronTrigger(options: CronOptions) {
  return new CronTrigger(options);
}

/** DynamicSchedule options
 * @param id Used to uniquely identify a DynamicSchedule
 */
export type DynamicIntervalOptions = { id: string };

/** DynamicSchedule` allows you to define a scheduled trigger that can be configured dynamically at runtime. */
export class DynamicSchedule implements Trigger<ScheduledEventSpecification> {
  /**
   * @param client The `TriggerClient` instance to use for registering the trigger.
   * @param options The options for the schedule.
   */
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
      examples,
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
