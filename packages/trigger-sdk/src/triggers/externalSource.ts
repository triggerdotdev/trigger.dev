import { z } from "zod";

import {
  EventFilter,
  SendEvent,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/internal";
import { Connection, IOWithConnections } from "../connections";
import { IO } from "../io";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import type { EventSpecification, Trigger, TriggerContext } from "../types";

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

type RegisterFunction<
  TConnection extends Connection<any, any>,
  TParams extends any
> = (
  params: TParams,
  eventSpecification: EventSpecification<any>,
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
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>,
  TParams extends any
> = {
  schema: z.Schema<TParams>;
  connection: TConnection;
  register: RegisterFunction<TConnection, TParams>;
  handler: HandlerFunction<TChannel, TConnection>;
};

export interface AnExternalSource {
  connection: Connection<any, any>;
  register: (
    params: any,
    spec: EventSpecification<any>,
    io: IO,
    ctx: TriggerContext
  ) => Promise<any>;
}

export class ExternalSource<
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>,
  TParams extends any
> implements AnExternalSource
{
  channel: TChannel;
  version: string;

  constructor(
    channel: TChannel,
    version: string,
    private options: ExternalSourceOptions<TChannel, TConnection, TParams>
  ) {
    this.channel = channel;
    this.version = version;
  }

  async register(
    params: TParams,
    spec: EventSpecification<any>,
    io: IO,
    ctx: TriggerContext
  ) {
    return await this.options.register(
      params,
      spec,
      io as IOWithConnections<{ client: TConnection }>,
      ctx
    );
  }

  get connection() {
    return this.options.connection;
  }
}

export type ExternalSourceParams<
  TExternalSource extends ExternalSource<any, any, any>
> = TExternalSource extends ExternalSource<any, any, infer TParams>
  ? TParams
  : never;

export type ExternalSourceTriggerOptions<
  TEventSpecification extends EventSpecification<any>,
  TEventSource extends ExternalSource<any, any, any>
> = {
  event: TEventSpecification;
  source: TEventSource;
  params: ExternalSourceParams<TEventSource>;
  filter?: EventFilter;
};

export class ExternalSourceTrigger<
  TEventSpecification extends EventSpecification<any>,
  TEventSource extends ExternalSource<any, any, any>
> implements Trigger<TEventSpecification>
{
  constructor(
    private options: ExternalSourceTriggerOptions<
      TEventSpecification,
      TEventSource
    >
  ) {}

  get event() {
    return this.options.event;
  }

  toJSON(): Array<TriggerMetadata> {
    return [
      {
        type: "static",
        title: "External Source",
        rule: {
          event: this.event.name,
          payload: deepMergeFilters(
            this.options.filter ?? {},
            this.event.filter ?? {}
          ),
          source: this.event.source,
        },
      },
    ];
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpecification>, any>
  ) {}
}

type RawSourceTriggerEvent<TChannel extends ChannelNames> = {
  rawEvent: ExternalSourceChannelMap[TChannel]["event"];
  source: { key: string; secret: string; data: any };
};

// function rawSourceTrigger<TChannel extends ChannelNames>(
//   channel: TChannel,
//   key: string
// ): Trigger<RawSourceTriggerEvent<TChannel>> {
//   return new RawSourceEventTrigger(channel, key);
// }

// class RawSourceEventTrigger<TChannel extends ChannelNames>
//   implements Trigger<RawSourceTriggerEvent<TChannel>>
// {
//   constructor(private channel: TChannel, private key: string) {}

//   eventElements(event: ApiEventLog): DisplayElement[] {
//     return [];
//   }

//   toJSON(): TriggerMetadata {
//     return {
//       title: "Handle Raw Source Event",
//       elements: [{ label: "sourceKey", text: this.key }],
//       eventRule: {
//         event: "internal.trigger.handle-raw-source-event",
//         source: "trigger.dev",
//         payload: {
//           source: { key: [this.key] },
//         },
//       },
//     };
//   }

//   parsePayload(payload: unknown): RawSourceTriggerEvent<TChannel> {
//     return payload as RawSourceTriggerEvent<TChannel>;
//   }

//   attach(
//     triggerClient: TriggerClient,
//     job: Job<Trigger<RawSourceTriggerEvent<TChannel>>, any>,
//     variantId?: string
//   ): void {}
// }

// const PrepareTriggerEventSchema = z.object({
//   jobId: z.string(),
//   jobVersion: z.string(),
//   variantId: z.string().optional(),
// });

// type PrepareTriggerEvent = z.infer<typeof PrepareTriggerEventSchema>;

// class PrepareTriggerInternalTrigger implements Trigger<PrepareTriggerEvent> {
//   constructor(
//     private job: Job<Trigger<any>, any>,
//     private variantId?: string
//   ) {}

//   eventElements(event: ApiEventLog): DisplayElement[] {
//     return [];
//   }

//   toJSON(): TriggerMetadata {
//     return {
//       title: "Prepare Trigger",
//       elements: [
//         { label: "id", text: this.job.id },
//         { label: "version", text: this.job.version },
//       ],
//       eventRule: {
//         event: "internal.trigger.prepare",
//         source: "trigger.dev",
//         payload: {
//           jobId: [this.job.id],
//           jobVersion: [this.job.version],
//           variantId: this.variantId ? [this.variantId] : [],
//         },
//       },
//     };
//   }

//   parsePayload(payload: unknown): PrepareTriggerEvent {
//     return PrepareTriggerEventSchema.parse(payload);
//   }

//   attach(
//     triggerClient: TriggerClient,
//     job: Job<Trigger<PrepareTriggerEvent>, any>,
//     variantId?: string
//   ): void {}
// }

// export function internalPrepareTrigger(
//   job: Job<Trigger<any>, any>,
//   variantId?: string
// ): Trigger<PrepareTriggerEvent> {
//   return new PrepareTriggerInternalTrigger(job, variantId);
// }
