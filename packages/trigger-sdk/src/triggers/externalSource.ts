import type {
  ApiEventLog,
  EventRule,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DisplayElement } from "@trigger.dev/internal";
import { z } from "zod";

import {
  NormalizedRequest,
  NormalizedResponse,
  SendEvent,
} from "@trigger.dev/internal";
import { Connection, IOWithConnections } from "../connections";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import type { Trigger, TriggerContext } from "../types";

type HttpSourceEvent = {
  request: NormalizedRequest;
  secret?: string;
};

type SmtpSourceEvent = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

type SqsSourceEvent = {
  body: string;
};

type ExternalSourceChannelMap = {
  http: {
    event: HttpSourceEvent;
  };
  smtp: {
    event: SmtpSourceEvent;
  };
  sqs: {
    event: SqsSourceEvent;
  };
};

type ChannelNames = keyof ExternalSourceChannelMap;

type RegisterFunction<TConnection extends Connection<any, any>> = (
  io: IOWithConnections<{ client: TConnection }>,
  ctx: TriggerContext
) => Promise<void>;

type HandlerFunction<
  TEvent extends any,
  TConnection extends Connection<any, any>
> = (
  event: TEvent,
  io: IOWithConnections<{ client: TConnection }>,
  ctx: TriggerContext
) => Promise<{ response: NormalizedResponse; events: SendEvent[] }>;

type ExternalSourceOptions<
  TEvent extends any,
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> = {
  connection: TConnection;
  register: RegisterFunction<TConnection>;
  handler: HandlerFunction<
    ExternalSourceChannelMap[TChannel]["event"],
    TConnection
  >;
  parsePayload: (payload: unknown) => TEvent;
};

export class ExternalSource<
  TEvent extends any,
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> {
  channel: TChannel;

  constructor(
    channel: TChannel,
    private options: ExternalSourceOptions<TEvent, TChannel, TConnection>
  ) {
    this.channel = channel;
  }

  async register(
    io: IOWithConnections<{ client: TConnection }>,
    ctx: TriggerContext
  ) {
    await this.options.register(io, ctx);
  }

  async handle(
    event: ExternalSourceChannelMap[TChannel]["event"],
    io: IOWithConnections<{ client: TConnection }>,
    ctx: TriggerContext
  ) {
    return await this.options.handler(event, io, ctx);
  }

  get connection() {
    return this.options.connection;
  }
}

export type ExternalSourceEventTriggerOptions<
  TEvent extends any,
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> = {
  title: string;
  eventRule: EventRule;
  elements: DisplayElement[];
  source: ExternalSource<TEvent, TChannel, TConnection>;
};

export class ExternalSourceEventTrigger<
  TEventType extends any,
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> implements Trigger<TEventType>
{
  constructor(
    private options: ExternalSourceEventTriggerOptions<
      TEventType,
      TChannel,
      TConnection
    >
  ) {}

  eventElements(event: ApiEventLog): DisplayElement[] {
    return [];
  }

  parsePayload(payload: unknown): TEventType {
    return payload as TEventType;
  }

  toJSON(): TriggerMetadata {
    return {
      title: this.options.title,
      elements: this.options.elements,
      eventRule: this.options.eventRule,
    };
  }

  attach(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventType>, any>,
    variantId?: string
  ): void {
    triggerClient.attach(
      new Job({
        id: `${job.id}-prepare-external-trigger${
          variantId ? `-${variantId}` : ""
        }`,
        name: `Prepare ${this.options.title}`,
        version: job.version,
        trigger: internalPrepareTrigger(job, variantId),
        connections: {
          client: this.options.source.connection,
        },
        run: async (event, io, ctx) => {
          return await this.options.source.register(io, ctx);
        },
        // @ts-ignore
        __internal: true,
      })
    );

    triggerClient.attach(
      new Job({
        id: `${job.id}-handle-external-trigger${
          variantId ? `-${variantId}` : ""
        }`,
        name: `Handle ${this.options.title}`,
        version: job.version,
        trigger: rawSourceTrigger(this.options.source.channel, job, variantId),
        connections: {
          client: this.options.source.connection,
        },
        run: async (event, io, ctx) => {
          const { response, events } = await this.options.source.handle(
            event,
            io,
            ctx
          );

          return {
            response,
            events,
          };
        },
        // @ts-ignore
        __internal: true,
      })
    );
  }
}

function rawSourceTrigger<
  TChannel extends ChannelNames,
  TEvent extends ExternalSourceChannelMap[TChannel]["event"]
>(
  channel: TChannel,
  job: Job<Trigger<any>, any>,
  variantId?: string
): Trigger<TEvent> {
  return new RawSourceEventTrigger(channel, job, variantId);
}

class RawSourceEventTrigger<
  TChannel extends ChannelNames,
  TEvent extends ExternalSourceChannelMap[TChannel]["event"]
> implements Trigger<TEvent>
{
  constructor(
    private channel: TChannel,
    private job: Job<Trigger<any>, any>,
    private variantId?: string
  ) {}

  eventElements(event: ApiEventLog): DisplayElement[] {
    return [];
  }

  toJSON(): TriggerMetadata {
    return {
      title: "Handle Raw Source Event",
      elements: [
        { label: "id", text: this.job.id },
        { label: "version", text: this.job.version },
      ],
      eventRule: {
        event: "internal.trigger.handle-raw-source-event",
        source: "trigger.dev",
        payload: {
          jobId: [this.job.id],
          jobVersion: [this.job.version],
          variantId: this.variantId ? [this.variantId] : [],
        },
      },
    };
  }

  parsePayload(payload: unknown): TEvent {
    return payload as TEvent;
  }

  attach(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEvent>, any>,
    variantId?: string
  ): void {}
}

const PrepareTriggerEventSchema = z.object({
  jobId: z.string(),
  jobVersion: z.string(),
  variantId: z.string().optional(),
});

type PrepareTriggerEvent = z.infer<typeof PrepareTriggerEventSchema>;

class PrepareTriggerInternalTrigger implements Trigger<PrepareTriggerEvent> {
  constructor(
    private job: Job<Trigger<any>, any>,
    private variantId?: string
  ) {}

  eventElements(event: ApiEventLog): DisplayElement[] {
    return [];
  }

  toJSON(): TriggerMetadata {
    return {
      title: "Prepare Trigger",
      elements: [
        { label: "id", text: this.job.id },
        { label: "version", text: this.job.version },
      ],
      eventRule: {
        event: "internal.trigger.prepare",
        source: "trigger.dev",
        payload: {
          jobId: [this.job.id],
          jobVersion: [this.job.version],
          variantId: this.variantId ? [this.variantId] : [],
        },
      },
    };
  }

  parsePayload(payload: unknown): PrepareTriggerEvent {
    return PrepareTriggerEventSchema.parse(payload);
  }

  attach(
    triggerClient: TriggerClient,
    job: Job<Trigger<PrepareTriggerEvent>, any>,
    variantId?: string
  ): void {}
}

export function internalPrepareTrigger(
  job: Job<Trigger<any>, any>,
  variantId?: string
): Trigger<PrepareTriggerEvent> {
  return new PrepareTriggerInternalTrigger(job, variantId);
}
