import type {
  ApiEventLog,
  EventRule,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DisplayElement } from "@trigger.dev/internal";
import { z } from "zod";

import { SendEvent } from "@trigger.dev/internal";
import { Connection, IOWithConnections } from "../connections";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import type { Trigger, TriggerContext } from "../types";

type HttpSourceEvent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody?: string | null;
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
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> = (
  event: RawSourceTriggerEvent<TChannel>,
  io: IOWithConnections<{ client: TConnection }>,
  ctx: TriggerContext
) => Promise<{ events: SendEvent[] }>;

type ExternalSourceOptions<
  TEvent extends any,
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> = {
  connection: TConnection;
  register: RegisterFunction<TConnection>;
  handler: HandlerFunction<TChannel, TConnection>;
  parsePayload: (payload: unknown) => TEvent;
};

export class ExternalSource<
  TEvent extends any,
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> {
  channel: TChannel;
  key: string;
  version: string;

  constructor(
    channel: TChannel,
    key: string,
    version: string,
    private options: ExternalSourceOptions<TEvent, TChannel, TConnection>
  ) {
    this.key = key;
    this.channel = channel;
    this.version = version;
  }

  async register(
    io: IOWithConnections<{ client: TConnection }>,
    ctx: TriggerContext
  ) {
    return await this.options.register(io, ctx);
  }

  async handle(
    event: RawSourceTriggerEvent<TChannel>,
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
    new Job(triggerClient, {
      id: `${job.id}-prepare-external-trigger${
        variantId ? `-${variantId}` : ""
      }`,
      name: `Prepare ${this.options.title}`,
      version: job.version,
      trigger: internalPrepareTrigger(job, variantId),
      connections: {
        client: this.options.source.connection,
      },
      queue: {
        name: `internal:${triggerClient.name}`,
        maxConcurrent: 1,
      },
      run: async (event, io, ctx) => {
        return await this.options.source.register(io, ctx);
      },
      // @ts-ignore
      __internal: true,
    });
  }
}

type RawSourceTriggerEvent<TChannel extends ChannelNames> = {
  rawEvent: ExternalSourceChannelMap[TChannel]["event"];
  source: { key: string; secret: string; data: any };
};

function rawSourceTrigger<TChannel extends ChannelNames>(
  channel: TChannel,
  key: string
): Trigger<RawSourceTriggerEvent<TChannel>> {
  return new RawSourceEventTrigger(channel, key);
}

class RawSourceEventTrigger<TChannel extends ChannelNames>
  implements Trigger<RawSourceTriggerEvent<TChannel>>
{
  constructor(private channel: TChannel, private key: string) {}

  eventElements(event: ApiEventLog): DisplayElement[] {
    return [];
  }

  toJSON(): TriggerMetadata {
    return {
      title: "Handle Raw Source Event",
      elements: [{ label: "sourceKey", text: this.key }],
      eventRule: {
        event: "internal.trigger.handle-raw-source-event",
        source: "trigger.dev",
        payload: {
          source: { key: [this.key] },
        },
      },
    };
  }

  parsePayload(payload: unknown): RawSourceTriggerEvent<TChannel> {
    return payload as RawSourceTriggerEvent<TChannel>;
  }

  attach(
    triggerClient: TriggerClient,
    job: Job<Trigger<RawSourceTriggerEvent<TChannel>>, any>,
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
