import {
  DisplayProperty,
  EventFilter,
  HandleTriggerSource,
  RegisterWebhookSource,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/core";
import { IOWithIntegrations, TriggerIntegration } from "../integrations.js";
import { IO } from "../io.js";
import { Job } from "../job.js";
import { TriggerClient } from "../triggerClient.js";
import type {
  EventSpecification,
  SchemaParser,
  Trigger,
  TriggerContext,
  VerifyResult,
} from "../types.js";
import { slugifyId } from "../utils.js";
import { SerializableJson } from "@trigger.dev/core";
import { Prettify } from "@trigger.dev/core";
import { createHash } from "node:crypto";

type WebhookCRUDContext<TParams extends any, TConfig extends Record<string, string[]>> = {
  active: boolean;
  params: TParams;
  config: {
    current: Partial<TConfig>;
    desired: TConfig;
  };
  url: string;
  secret: string;
};

type WebhookCRUDFunction<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TConfig extends Record<string, string[]>,
> = (options: {
  io: IOWithIntegrations<{ integration: TIntegration }>;
  ctx: WebhookCRUDContext<TParams, TConfig>;
}) => Promise<any>;

interface WebhookCRUD<
  TIntegration extends TriggerIntegration,
  TParams extends any,
  TConfig extends Record<string, string[]>,
> {
  create: WebhookCRUDFunction<TIntegration, TParams, TConfig>;
  read?: WebhookCRUDFunction<TIntegration, TParams, TConfig>; // currently unused
  update?: WebhookCRUDFunction<TIntegration, TParams, TConfig>;
  delete: WebhookCRUDFunction<TIntegration, TParams, TConfig>;
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

export type WebhookDeliveryContext = {
  key: string;
  secret: string;
  params: any;
};

type EventGenerator<
  TParams extends any,
  TConfig extends Record<string, string[]>,
  TIntegration extends TriggerIntegration,
> = (options: {
  request: Request;
  client: TriggerClient;
  ctx: WebhookDeliveryContext;
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
  };
  key: KeyFunction<TParams>;
  crud: WebhookCRUD<TIntegration, TParams, TConfig>;
  filter?: FilterFunction<TParams, TConfig>;
  register?: RegisterFunction<TIntegration, TParams, TConfig>;
  verify?: (options: {
    request: Request;
    client: TriggerClient;
    ctx: WebhookDeliveryContext;
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

  async generateEvents(request: Request, client: TriggerClient, ctx: WebhookDeliveryContext) {
    return this.options.generateEvents({
      request,
      client,
      ctx,
    });
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
    client: TriggerClient,
    ctx: WebhookDeliveryContext
  ): Promise<VerifyResult> {
    if (this.options.verify) {
      const clonedRequest = request.clone();
      return this.options.verify({ request: clonedRequest, client, ctx });
    }

    return { success: true as const };
  }

  #shortHash(str: string) {
    const hash = createHash("sha1").update(str).digest("hex");
    return hash.slice(0, 7);
  }

  key(params: TParams): string {
    const parts = ["webhook"];

    parts.push(this.options.key(params));
    parts.push(this.integration.id);

    return `${this.options.id}-${this.#shortHash(parts.join(""))}`;
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

export type GetWebhookParams<TWebhook extends WebhookSource<any, any, any>> =
  TWebhook extends WebhookSource<any, infer TParams, any> ? TParams : never;

export type GetWebhookConfig<TWebhook extends WebhookSource<any, any, any>> =
  TWebhook extends WebhookSource<any, any, infer TConfig> ? TConfig : never;

export type WebhookTriggerOptions<
  TEventSpecification extends EventSpecification<any>,
  TEventSource extends WebhookSource<any, any, any>,
  TConfig extends Record<string, string[]> = Record<string, string[]>,
> = {
  event: TEventSpecification;
  source: TEventSource;
  params: GetWebhookParams<TEventSource>;
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

  get source() {
    return this.options.source;
  }

  get key() {
    return slugifyId(this.options.source.key(this.options.params));
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
      link: `http-endpoints/${this.key}`,
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
    triggerClient.defineHttpEndpoint(
      {
        id: this.key,
        source: "trigger.dev",
        icon: this.event.icon,
        verify: async () => ({ success: true }),
      },
      true
    );

    triggerClient.attachWebhook({
      key: this.key,
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
