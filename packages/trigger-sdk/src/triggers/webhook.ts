import {
  DisplayProperty,
  EventFilter,
  HandleTriggerSource,
  HttpSourceResponseMetadata,
  Logger,
  NormalizedResponse,
  RegisterWebhookPayload,
  RegisterWebhookSource,
  SendEvent,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/core";
import { IOWithIntegrations, TriggerIntegration } from "../integrations";
import { IO } from "../io";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import type {
  ConfigDiff,
  EventSpecification,
  SchemaParser,
  Trigger,
  TriggerContext,
  VerifyResult,
} from "../types";
import { slugifyId } from "../utils";
import { SerializableJson } from "@trigger.dev/core";
import { ConnectionAuth } from "@trigger.dev/core";
import { Prettify } from "@trigger.dev/core";
import { VerifyCallback } from "../httpEndpoint";

type WebhookCRUDFunction<TIntegration extends TriggerIntegration> = (options: {
  io: IOWithIntegrations<{ integration: TIntegration }>;
  ctx: RegisterWebhookPayload & {
    config: {
      diff: ConfigDiff;
    };
  };
}) => Promise<any>;

interface WebhookCRUD<TIntegration extends TriggerIntegration> {
  create: WebhookCRUDFunction<TIntegration>;
  read: WebhookCRUDFunction<TIntegration>;
  update?: WebhookCRUDFunction<TIntegration>;
  delete: WebhookCRUDFunction<TIntegration>;
}

export type WebhookConfig<TConfigKeys extends string> = {
  [K in TConfigKeys]: string[];
};

type RegisterFunctionEvent<TParams extends any, TConfig extends Record<string, string[]> = any> = {
  source: {
    active: boolean;
    data?: any;
    secret: string;
    url: string;
  };
  params: TParams;
  config: TConfig;
};

type WebhookRegisterEvent<TConfig extends Record<string, string[]> = any> = {
  id: string;
  source: RegisterWebhookSource;
  dynamicTriggerId?: string;
  config: TConfig;
};

type RegisterFunctionOutput<TConfig extends Record<string, string[]> = any> = {
  secret?: string;
  data?: SerializableJson;
  config: TConfig;
};

type RegisterFunction<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TConfig extends Record<string, string[]> = any,
> = (
  event: RegisterFunctionEvent<TParams, TConfig>,
  io: IOWithIntegrations<{ integration: TIntegration }>,
  ctx: TriggerContext
) => Promise<RegisterFunctionOutput<TConfig> | undefined>;

export type HandlerEvent<TParams extends any = any> = {
  rawEvent: Request;
  source: Prettify<Omit<HandleTriggerSource, "params"> & { params: TParams }>;
};

type HandlerFunction<TParams extends any, TTriggerIntegration extends TriggerIntegration> = (
  event: HandlerEvent<TParams>,
  logger: Logger,
  integration: TTriggerIntegration,
  auth?: ConnectionAuth
) => Promise<{
  events: SendEvent[];
  response?: NormalizedResponse;
  metadata?: HttpSourceResponseMetadata;
} | void>;

type KeyFunction<TParams extends any> = (params: TParams) => string;
type FilterFunction<TParams extends any, TConfig extends Record<string, string[]> = any> = (
  params: TParams,
  config?: TConfig
) => EventFilter;

type WebhookOptions<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TConfig extends Record<string, string[]> = any,
> = {
  id: string;
  version: string;
  schemas: {
    params: SchemaParser<TParams>;
    config?: SchemaParser<TConfig>;
  };
  integration: TIntegration;
  crud: WebhookCRUD<TIntegration>;
  register: RegisterFunction<TIntegration, TParams, TConfig>;
  filter?: FilterFunction<TParams, TConfig>;
  handler: HandlerFunction<TParams, TIntegration>;
  key: KeyFunction<TParams>;
  properties?: (params: TParams) => DisplayProperty[];
  verify?: VerifyCallback;
};

export class WebhookSource<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TConfig extends Record<string, string[]> = any,
> {
  constructor(private options: WebhookOptions<TIntegration, TParams, TConfig>) {}

  async handle(source: HandleTriggerSource, rawEvent: Request, logger: Logger) {
    return this.options.handler(
      {
        source: { ...source, params: source.params as TParams },
        rawEvent,
      },
      logger,
      this.options.integration
    );
  }

  filter(params: TParams, config?: TConfig): EventFilter {
    return this.options.filter?.(params, config) ?? {};
  }

  properties(params: TParams): DisplayProperty[] {
    return this.options.properties?.(params) ?? [];
  }

  get crud() {
    return this.options.crud;
  }

  async register(
    params: TParams,
    registerEvent: WebhookRegisterEvent<TConfig>,
    io: IO,
    ctx: TriggerContext
  ) {
    const updates = await this.options.register(
      {
        ...registerEvent,
        params,
      },
      io as IOWithIntegrations<{ integration: TIntegration }>,
      ctx
    );

    return updates;
  }

  async verify(request: Request): Promise<VerifyResult> {
    if (this.options.verify) {
      return this.options.verify(request);
    }

    return { success: true as const };
  }

  key(params: TParams): string {
    const parts = [this.options.id, "webhook"];

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

export type WebhookParams<TWebhook extends WebhookSource<any, any, any>> =
  TWebhook extends WebhookSource<any, infer TParams, any> ? TParams : never;

export type WebhookTriggerOptions<
  TEventSpecification extends EventSpecification<any>,
  TEventSource extends WebhookSource<any, any, any>,
  TConfig extends Record<string, string[]> = any,
> = {
  event: TEventSpecification;
  source: TEventSource;
  params: WebhookParams<TEventSource>;
  config: TConfig;
};

export class WebhookTrigger<
  TEventSpecification extends EventSpecification<any>,
  TEventSource extends WebhookSource<any, any, any>,
> implements Trigger<TEventSpecification>
{
  constructor(private options: WebhookTriggerOptions<TEventSpecification, TEventSource>) {}

  get event() {
    return this.options.event;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "static",
      title: "Webhook",
      rule: {
        event: this.event.name,
        payload: deepMergeFilters(
          this.options.source.filter(this.options.params, this.options.config),
          this.event.filter ?? {}
        ),
        source: this.event.source,
      },
      properties: this.options.source.properties(this.options.params),
    };
  }

  filter(eventFilter: EventFilter) {
    const { event, ...optionsWithoutEvent } = this.options;
    const { filter, ...eventWithoutFilter } = event;

    return new WebhookTrigger({
      ...optionsWithoutEvent,
      event: {
        ...eventWithoutFilter,
        filter: deepMergeFilters(filter ?? {}, eventFilter),
      },
    });
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>) {
    const key = slugifyId(this.options.source.key(this.options.params));

    triggerClient.defineHttpEndpoint({
      id: key,
      source: "trigger.dev",
      verify: async () => ({ success: true }),
    });

    triggerClient.attachWebhook({
      key,
      source: this.options.source,
      event: this.options.event,
      params: this.options.params,
      config: this.options.config,
    });
  }

  get preprocessRuns() {
    return true;
  }

  async verifyPayload(payload: ReturnType<TEventSpecification["parsePayload"]>) {
    return { success: true as const };
  }
}
