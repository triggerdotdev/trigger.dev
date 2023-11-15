import {
  DisplayProperty,
  EventFilter,
  HandleTriggerSource,
  RegisterWebhookPayload,
  RegisterWebhookSource,
  TriggerMetadata,
  WebhookContextMetadataSchema,
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
import { Prettify } from "@trigger.dev/core";

type WebhookCRUDContext = {
  active: boolean;
  params?: any;
  config: {
    current: Record<string, string[]>;
    desired: Record<string, string[]>;
  };
  url: string;
  secret: string;
};

type WebhookCRUDFunction<TIntegration extends TriggerIntegration> = (options: {
  io: IOWithIntegrations<{ integration: TIntegration }>;
  // TODO: doesn't like RegisterWebhookPayload type for some reason
  ctx: WebhookCRUDContext & {
    config: {
      diff: ConfigDiff;
    };
  };
}) => Promise<any>;

interface WebhookCRUD<TIntegration extends TriggerIntegration> {
  create: WebhookCRUDFunction<TIntegration>;
  // currently unused
  read?: WebhookCRUDFunction<TIntegration>;
  update?: WebhookCRUDFunction<TIntegration>;
  delete: WebhookCRUDFunction<TIntegration>;
}

export type WebhookConfig<TConfigKeys extends string> = {
  [K in TConfigKeys]: string[];
};

type RegisterFunctionEvent<TParams extends any, TConfig extends Record<string, string[]>> = {
  source: {
    active: boolean;
    data?: any;
    secret: string;
    url: string;
  };
  params: TParams;
  config: TConfig;
};

type WebhookRegisterEvent<TConfig extends Record<string, string[]>> = {
  id: string;
  source: RegisterWebhookSource;
  dynamicTriggerId?: string;
  config: TConfig;
};

type RegisterFunctionOutput<TConfig extends Record<string, string[]>> = {
  secret?: string;
  data?: SerializableJson;
  config: TConfig;
};

type RegisterFunction<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TConfig extends Record<string, string[]>,
> = (
  event: RegisterFunctionEvent<TParams, TConfig>,
  io: IOWithIntegrations<{ integration: TIntegration }>,
  ctx: TriggerContext
) => Promise<RegisterFunctionOutput<TConfig> | undefined>;

export type WebhookHandlerEvent<TParams extends any = any> = {
  rawEvent: Request;
  source: Prettify<Omit<HandleTriggerSource, "params"> & { params: TParams }>;
};

type WebhookHandlerContext<TParams extends any, TConfig extends Record<string, string[]>> = {
  params: TParams;
  config: TConfig;
  secret: string;
};

type EventGenerator<
  TParams extends any,
  TConfig extends Record<string, string[]>,
  TIntegration extends TriggerIntegration,
> = (options: {
  request: Request;
  io: IOWithIntegrations<{ integration: TIntegration }>;
  ctx: TriggerContext & WebhookHandlerContext<TParams, TConfig>;
}) => Promise<any>;

type KeyFunction<TParams extends any> = (params: TParams) => string;

type FilterFunction<TParams extends any, TConfig extends Record<string, string[]>> = (
  params: TParams,
  config?: TConfig
) => EventFilter;

type WebhookOptions<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TConfig extends Record<string, string[]>,
> = {
  id: string;
  version: string;
  integration: TIntegration;
  schemas: {
    params: SchemaParser<TParams>;
    config?: SchemaParser<TConfig>;
    payload?: SchemaParser<TConfig>;
  };
  key: KeyFunction<TParams>;
  crud: WebhookCRUD<TIntegration>;
  filter?: FilterFunction<TParams, TConfig>;
  register?: RegisterFunction<TIntegration, TParams, TConfig>;
  verify?: (options: {
    request: Request;
    io: IOWithIntegrations<{ integration: TIntegration }>;
    ctx: TriggerContext & { webhook: { secret: string } };
  }) => Promise<VerifyResult>;
  generateEvents: EventGenerator<TParams, TConfig, TIntegration>;
  properties?: (params: TParams) => DisplayProperty[];
};

export class WebhookSource<
  TIntegration extends TriggerIntegration,
  TParams extends any = any,
  TConfig extends Record<string, string[]> = Record<string, string[]>,
> {
  constructor(private options: WebhookOptions<TIntegration, TParams, TConfig>) {}

  async generateEvents(
    request: Request,
    io: IOWithIntegrations<{ integration: TIntegration }>,
    ctx: TriggerContext & { webhook: { secret: string } }
  ) {
    if (!ctx.source) {
      throw new Error("Source context should be defined.");
    }

    const sourceMetadata = WebhookContextMetadataSchema.parse(ctx.source.metadata);

    const handlerContext = {
      params: sourceMetadata.params,
      config: sourceMetadata.config as TConfig,
      secret: sourceMetadata.secret,
    };

    return this.options.generateEvents({ request, io, ctx: { ...ctx, ...handlerContext } });
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
    if (!this.options.register) {
      return;
    }

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

  async verify(
    request: Request,
    io: IOWithIntegrations<{ integration: TIntegration }>,
    ctx: TriggerContext & { webhook: { secret: string } }
  ): Promise<VerifyResult> {
    if (this.options.verify) {
      const clonedRequest = request.clone();
      return this.options.verify({ request: clonedRequest, io, ctx });
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
  TConfig extends Record<string, string[]> = Record<string, string[]>,
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
      icon: this.event.icon,
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
