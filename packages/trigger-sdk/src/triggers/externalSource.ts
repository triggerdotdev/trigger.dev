import { z } from "zod";

import {
  EventFilter,
  RegisterSourceEvent,
  SendEvent,
  TriggerMetadata,
  UpdateTriggerSourceBody,
  deepMergeFilters,
} from "@trigger.dev/internal";
import {
  Connection,
  IOWithConnections,
  connectionConfig,
} from "../connections";
import { IO } from "../io";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import type { EventSpecification, Trigger, TriggerContext } from "../types";
import { slugifyId } from "../utils";

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
  HTTP: {
    event: HttpSourceEvent;
    register: {
      url: string;
    };
  };
  SMTP: {
    event: SmtpSourceEvent;
    register: {};
  };
  SQS: {
    event: SqsSourceEvent;
    register: {};
  };
};

type ChannelNames = keyof ExternalSourceChannelMap;

type RegisterFunctionEvent<
  TChannel extends ChannelNames,
  TParams extends any
> = {
  events: Array<string>;
  missingEvents: Array<string>;
  orphanedEvents: Array<string>;
  source: {
    active: boolean;
    data?: any;
    secret: string;
  } & ExternalSourceChannelMap[TChannel]["register"];
  params: TParams;
};

type RegisterFunction<
  TConnection extends Connection<any, any>,
  TParams extends any,
  TChannel extends ChannelNames
> = (
  event: RegisterFunctionEvent<TChannel, TParams>,
  io: IOWithConnections<{ client: TConnection }>,
  ctx: TriggerContext
) => Promise<UpdateTriggerSourceBody | undefined>;

type HandlerFunction<
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>
> = (
  event: RawSourceTriggerEvent<TChannel>,
  io: IOWithConnections<{ client: TConnection }>,
  ctx: TriggerContext
) => Promise<{ events: SendEvent[] }>;

type KeyFunction<TParams extends any> = (params: TParams) => string;

type ExternalSourceOptions<
  TChannel extends ChannelNames,
  TConnection extends Connection<any, any>,
  TParams extends any
> = {
  id: string;
  version: string;
  schema: z.Schema<TParams>;
  connection: TConnection;
  register: RegisterFunction<TConnection, TParams, TChannel>;
  key: KeyFunction<TParams>;
};

export interface AnExternalSource {
  connection: Connection<any, any>;
  register: (
    params: any,
    event: RegisterSourceEvent,
    io: IO,
    ctx: TriggerContext
  ) => Promise<any>;
}

export class ExternalSource<
  TConnection extends Connection<any, any>,
  TParams extends any,
  TChannel extends ChannelNames = ChannelNames
> implements AnExternalSource
{
  channel: TChannel;

  constructor(
    channel: TChannel,
    private options: ExternalSourceOptions<TChannel, TConnection, TParams>
  ) {
    this.channel = channel;
  }

  async register(
    params: TParams,
    registerEvent: RegisterSourceEvent,
    io: IO,
    ctx: TriggerContext
  ) {
    const { result: event, ommited: source } = omit(registerEvent, "source");
    const { result: sourceWithoutChannel, ommited: channel } = omit(
      source,
      "channel"
    );
    const { result: channelWithoutType } = omit(channel, "type");

    const updates = await this.options.register(
      {
        ...event,
        source: { ...sourceWithoutChannel, ...channelWithoutType },
        params,
      },
      io as IOWithConnections<{ client: TConnection }>,
      ctx
    );

    return updates;
  }

  key(params: TParams): string {
    const parts = [this.options.id, this.channel];

    parts.push(this.options.key(params));

    if (this.connectionConfig) {
      parts.push(this.connectionConfig.id);
    }

    return parts.join("-");
  }

  get connection() {
    return this.options.connection;
  }

  get connectionConfig() {
    return connectionConfig(this.options.connection);
  }

  get id() {
    return this.options.id;
  }

  get version() {
    return this.options.version;
  }
}

export type ExternalSourceParams<
  TExternalSource extends ExternalSource<any, any, any>
> = TExternalSource extends ExternalSource<any, infer TParams, any>
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

  get requiresPreparaton(): boolean {
    return true;
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
    job: Job<Trigger<TEventSpecification>, any>,
    index?: number
  ) {
    triggerClient.attachSource({
      key: slugifyId(this.options.source.key(this.options.params)),
      source: this.options.source,
      event: this.options.event,
      params: this.options.params,
    });
  }
}

// const PrepareTriggerEventSchema = z.object({
//   jobId: z.string(),
//   jobVersion: z.string(),
// });

// type PrepareTriggerEvent = z.infer<typeof PrepareTriggerEventSchema>;

// const prepareTriggerSpecification: EventSpecification<PrepareTriggerEvent> = {
//   name: "trigger.internal.prepare",
//   title: "Prepare Trigger",
//   source: "internal",
//   parsePayload: PrepareTriggerEventSchema.parse,
// };

// function prepareJobTrigger(
//   job: Job<Trigger<EventSpecification<PrepareTriggerEvent>>, any>
// ) {
//   return new CustomTrigger({
//     event: prepareTriggerSpecification,
//     filter: { jobId: [job.id], jobVersion: [job.version] },
//   });
// }

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

export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  key: K
): { result: Omit<T, K>; ommited: T[K] } {
  const result: any = {};

  for (const k of Object.keys(obj)) {
    if (k === key) continue;

    result[k] = obj[k];
  }

  return { result, ommited: obj[key] };
}
