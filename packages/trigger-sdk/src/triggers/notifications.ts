import {
  MISSING_CONNECTION_NOTIFICATION,
  MISSING_CONNECTION_RESOLVED_NOTIFICATION,
  MissingConnectionNotificationPayload,
  MissingConnectionNotificationPayloadSchema,
  MissingConnectionResolvedNotificationPayload,
  MissingConnectionResolvedNotificationPayloadSchema,
  TriggerMetadata,
} from "@trigger.dev/core";
import { TriggerIntegration } from "../integrations";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";

export function missingConnectionNotification(integrations: Array<TriggerIntegration>) {
  return new MissingConnectionNotification({ integrations });
}

export function missingConnectionResolvedNotification(integrations: Array<TriggerIntegration>) {
  return new MissingConnectionResolvedNotification({ integrations });
}

type MissingConnectionNotificationSpecification =
  EventSpecification<MissingConnectionNotificationPayload>;

type MissingConnectionNotificationOptions = {
  integrations: Array<TriggerIntegration>;
};

export class MissingConnectionNotification
  implements Trigger<MissingConnectionNotificationSpecification>
{
  constructor(private options: MissingConnectionNotificationOptions) {}

  get event() {
    return {
      name: MISSING_CONNECTION_NOTIFICATION,
      title: "Missing Connection Notification",
      source: "trigger.dev",
      icon: "connection-alert",
      parsePayload: MissingConnectionNotificationPayloadSchema.parse,
      properties: [
        {
          label: "Integrations",
          text: this.options.integrations.map((i) => i.id).join(", "),
        },
      ],
    };
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<MissingConnectionNotificationSpecification>, any>
  ): void {}

  get preprocessRuns() {
    return false;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "static",
      title: this.event.title,
      rule: {
        event: this.event.name,
        source: "trigger.dev",
        payload: {
          client: {
            id: this.options.integrations.map((i) => i.id),
          },
        },
      },
    };
  }
}

type MissingConnectionResolvedNotificationSpecification =
  EventSpecification<MissingConnectionResolvedNotificationPayload>;

export class MissingConnectionResolvedNotification
  implements Trigger<MissingConnectionResolvedNotificationSpecification>
{
  constructor(private options: MissingConnectionNotificationOptions) {}

  get event() {
    return {
      name: MISSING_CONNECTION_RESOLVED_NOTIFICATION,
      title: "Missing Connection Resolved Notification",
      source: "trigger.dev",
      icon: "connection-alert",
      parsePayload: MissingConnectionResolvedNotificationPayloadSchema.parse,
      properties: [
        {
          label: "Integrations",
          text: this.options.integrations.map((i) => i.id).join(", "),
        },
      ],
    };
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<MissingConnectionResolvedNotificationSpecification>, any>
  ): void {}

  get preprocessRuns() {
    return false;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "static",
      title: this.event.title,
      rule: {
        event: this.event.name,
        source: "trigger.dev",
        payload: {
          client: {
            id: this.options.integrations.map((i) => i.id),
          },
        },
      },
    };
  }
}
