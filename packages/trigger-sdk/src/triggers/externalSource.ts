import { z } from "zod";

import {
  DisplayProperty,
  EventFilter,
  HandleTriggerSource,
  Logger,
  NormalizedResponse,
  RegisterTriggerSource,
  RegisteredOptionsDiff,
  SendEvent,
  TriggerMetadata,
  UpdateTriggerSourceBody,
  deepMergeFilters,
} from "@trigger.dev/core";
import { IOWithIntegrations, TriggerIntegration } from "../integrations";
import { IO } from "../io";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import type { EventSpecification, Trigger, TriggerContext } from "../types";
import { slugifyId } from "../utils";
import { SerializableJson } from "@trigger.dev/core";

export type HttpSourceEvent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody?: Buffer | null;
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
    event: Request;
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

type TriggerOptionDiff = {
  desired: string[];
  missing: string[];
  orphaned: string[];
};

type TriggerOptionDiffs<
  TTriggerOptionDefinitions extends Record<string, string[]> = Record<string, string[]>,
> = TriggerOptionsRecordWithEvent<TriggerOptionDiff, TTriggerOptionDefinitions>;

type TriggerOptionsRecordWithEvent<
  TValue,
  TTriggerOptionDefinitions extends Record<string, string[]>,
> = {
  event: TValue;
} & TriggerOptionRecord<TValue, TTriggerOptionDefinitions>;

export type TriggerOptionRecord<
  TValue,
  TTriggerOptionDefinitions extends Record<string, string[]> = Record<string, string[]>,
> = {
  [K in keyof TTriggerOptionDefinitions]: TValue;
};

type RegisterFunctionEvent<
  TChannel extends ChannelNames,
  TParams extends any,
  TTriggerOptionDefinitions extends Record<string, string[]> = Record<string, string[]>,
> = {
  options: TriggerOptionDiffs<TTriggerOptionDefinitions>;
  source: {
    active: boolean;
    data?: any;
    secret: string;
  } & ExternalSourceChannelMap[TChannel]["register"];
  params: TParams;
};

type RegisterSourceEvent<
  TTriggerOptionDefinitions extends Record<string, string[]> = Record<string, string[]>,
> = {
  id: string;
  source: RegisterTriggerSource;
  dynamicTriggerId?: string;
  options: TriggerOptionDiffs<TTriggerOptionDefinitions>;
};

type RegisterFunctionOutput<
  TTriggerOptionDefinitions extends Record<string, string[]> = Record<string, string[]>,
> = {
  secret?: string;
  data?: SerializableJson;
  options: TriggerOptionsRecordWithEvent<string[], TTriggerOptionDefinitions>;
};

type RegisterFunction<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TChannel extends ChannelNames,
  TTriggerOptionDefinitions extends Record<string, string[]> = Record<string, string[]>,
> = (
  event: RegisterFunctionEvent<TChannel, TParams, TTriggerOptionDefinitions>,
  io: IOWithIntegrations<{ integration: TIntegration }>,
  ctx: TriggerContext
) => Promise<RegisterFunctionOutput<TTriggerOptionDefinitions> | undefined>;

export type HandlerEvent<TChannel extends ChannelNames, TParams extends any = any> = {
  rawEvent: ExternalSourceChannelMap[TChannel]["event"];
  source: HandleTriggerSource & { params: TParams };
};

type HandlerFunction<TChannel extends ChannelNames, TParams extends any> = (
  event: HandlerEvent<TChannel, TParams>,
  logger: Logger
) => Promise<{ events: SendEvent[]; response?: NormalizedResponse } | void>;

type KeyFunction<TParams extends any> = (params: TParams) => string;
type FilterFunction<TParams extends any> = (params: TParams) => EventFilter;

type ExternalSourceOptions<
  TChannel extends ChannelNames,
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TTriggerOptionDefinitions extends Record<string, string[]> = any,
> = {
  id: string;
  version: string;
  schema: z.Schema<TParams>;
  optionSchema?: z.Schema<TTriggerOptionDefinitions>;
  integration: TIntegration;
  register: RegisterFunction<TIntegration, TParams, TChannel, TTriggerOptionDefinitions>;
  filter?: FilterFunction<TParams>;
  handler: HandlerFunction<TChannel, TParams>;
  key: KeyFunction<TParams>;
  properties?: (params: TParams) => DisplayProperty[];
};

export class ExternalSource<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TChannel extends ChannelNames = ChannelNames,
  TTriggerOptionDefinitions extends Record<string, string[]> = any,
> {
  channel: TChannel;

  constructor(
    channel: TChannel,
    private options: ExternalSourceOptions<
      TChannel,
      TIntegration,
      TParams,
      TTriggerOptionDefinitions
    >
  ) {
    this.channel = channel;
  }

  async handle(
    source: HandleTriggerSource,
    rawEvent: ExternalSourceChannelMap[TChannel]["event"],
    logger: Logger
  ) {
    return this.options.handler(
      {
        source: { ...source, params: source.params as TParams },
        rawEvent,
      },
      logger
    );
  }

  filter(params: TParams): EventFilter {
    return this.options.filter?.(params) ?? {};
  }

  properties(params: TParams): DisplayProperty[] {
    return this.options.properties?.(params) ?? [];
  }

  async register(
    params: TParams,
    registerEvent: RegisterSourceEvent<TTriggerOptionDefinitions>,
    io: IO,
    ctx: TriggerContext
  ) {
    const { result: event, ommited: source } = omit(registerEvent, "source");
    const { result: sourceWithoutChannel, ommited: channel } = omit(source, "channel");
    const { result: channelWithoutType } = omit(channel, "type");

    const updates = await this.options.register(
      {
        ...event,
        source: { ...sourceWithoutChannel, ...channelWithoutType },
        params,
      },
      io as IOWithIntegrations<{ integration: TIntegration }>,
      ctx
    );

    return updates;
  }

  key(params: TParams): string {
    const parts = [this.options.id, this.channel];

    parts.push(this.options.key(params));
    parts.push(this.integration.id);

    return parts.join("-");
  }

  get integration() {
    return this.options.integration;
  }

  get integrationConfig() {
    return {
      id: this.integration.id,
      metadata: this.integration.metadata,
    };
  }

  get id() {
    return this.options.id;
  }

  get version() {
    return this.options.version;
  }
}

export type ExternalSourceParams<TExternalSource extends ExternalSource<any, any, any>> =
  TExternalSource extends ExternalSource<any, infer TParams, any>
    ? TParams & { filter?: EventFilter }
    : never;

export type ExternalSourceTriggerOptions<
  TEventSpecification extends EventSpecification<any>,
  TEventSource extends ExternalSource<any, any, any>,
  TTriggerOptionDefinitions extends Record<string, string[]> = any,
> = {
  event: TEventSpecification;
  source: TEventSource;
  params: ExternalSourceParams<TEventSource>;
  options: TriggerOptionRecord<string[], TTriggerOptionDefinitions>;
};

export class ExternalSourceTrigger<
  TEventSpecification extends EventSpecification<any>,
  TEventSource extends ExternalSource<any, any, any>,
> implements Trigger<TEventSpecification>
{
  constructor(private options: ExternalSourceTriggerOptions<TEventSpecification, TEventSource>) {}

  get event() {
    return this.options.event;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "static",
      title: "External Source",
      rule: {
        event: this.event.name,
        payload: deepMergeFilters(
          this.options.source.filter(this.options.params),
          this.event.filter ?? {},
          this.options.params.filter ?? {}
        ),
        source: this.event.source,
      },
      properties: this.options.source.properties(this.options.params),
    };
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>) {
    triggerClient.attachSource({
      key: slugifyId(this.options.source.key(this.options.params)),
      source: this.options.source,
      event: this.options.event,
      params: this.options.params,
      options: this.options.options,
    });
  }

  get preprocessRuns() {
    return true;
  }
}

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
