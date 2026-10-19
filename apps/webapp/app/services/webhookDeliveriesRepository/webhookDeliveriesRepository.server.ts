import { type ClickHouse } from "@internal/clickhouse";
import { type Tracer } from "@internal/tracing";
import { type Logger, type LogLevel } from "@trigger.dev/core/logger";
import { type Prisma, type WebhookDeliveryStatus } from "@trigger.dev/database";
import { type WebhookReplicaDatabase } from "~/db.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { webhookLimitsForEnvironment } from "~/v3/webhookLimits.server";
import { ClickHouseWebhookDeliveriesRepository } from "./clickhouseWebhookDeliveriesRepository.server";

export type WebhookDeliveriesRepositoryOptions = {
  clickhouse: ClickHouse;
  prisma: WebhookReplicaDatabase;
  /** The org's delivery retention for an environment. Defaults to its webhook limits. */
  retentionDays?: (environmentId: string) => Promise<number>;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
};

export type FilterWebhookDeliveriesOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  webhookEndpointId?: string;
  webhookEndpointIds?: string[]; // webhook (handler) filter, resolved to endpoint ids by the presenter
  deliveryId?: string; // matches the delivery friendlyId OR external delivery id
  runId?: string; // INTERNAL run id (presenter resolves friendly -> internal)
  statuses?: WebhookDeliveryStatus[];
  isTest?: boolean;
  period?: number;
  from?: number;
  to?: number;
};

export type ListWebhookDeliveriesOptions = FilterWebhookDeliveriesOptions & {
  page: { size: number; cursor?: string; direction?: "forward" | "backward" };
};

export type WebhookDeliveryIdsPage = {
  deliveryIds: string[];
  pagination: { nextCursor: string | null; previousCursor: string | null };
};

export type ListedWebhookDelivery = Prisma.WebhookDeliveryGetPayload<{
  select: {
    id: true;
    friendlyId: true;
    webhookEndpointId: true;
    runtimeEnvironmentId: true;
    status: true;
    isTest: true;
    externalDeliveryId: true;
    runId: true;
    createdAt: true;
    processedAt: true;
    errorMessage: true;
  };
}>;

// The detail view selects more than the list, including the size-capped
// `parsedEvent` snapshot (which the list omits).
export type DetailedWebhookDelivery = Prisma.WebhookDeliveryGetPayload<{
  select: {
    id: true;
    friendlyId: true;
    webhookEndpointId: true;
    runtimeEnvironmentId: true;
    environmentType: true;
    status: true;
    isTest: true;
    externalDeliveryId: true;
    idempotencyKey: true;
    runId: true;
    rawBodyHash: true;
    parsedEvent: true;
    headers: true;
    errorMessage: true;
    filterReason: true;
    targets: true;
    createdAt: true;
    updatedAt: true;
    processedAt: true;
  };
}>;

export type GetWebhookDeliveryOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  friendlyId: string;
};

export type GetDeliveriesByFriendlyIdsOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  friendlyIds: string[];
};

export type CountDeliveriesByEndpointOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  webhookEndpointIds: string[];
  period: number; // lookback window in ms
};

/**
 * Options plus the org's delivery retention: deliveries older than it are hidden, even before their
 * partition is dropped.
 */
export type WithRetention<T> = T & { retentionDays: number };

interface IWebhookDeliveriesRepository {
  name: string;
  listDeliveryIds(options: ListWebhookDeliveriesOptions): Promise<WebhookDeliveryIdsPage>;
  listDeliveries(options: ListWebhookDeliveriesOptions): Promise<{
    deliveries: ListedWebhookDelivery[];
    pagination: { nextCursor: string | null; previousCursor: string | null };
  }>;
  getDeliveriesByFriendlyIds(
    options: GetDeliveriesByFriendlyIdsOptions
  ): Promise<ListedWebhookDelivery[]>;
  countDeliveries(options: FilterWebhookDeliveriesOptions): Promise<number>;
  // One grouped query for many endpoints -> Map<endpointId, count> (avoids an N+1 of count queries).
  countDeliveriesByEndpoint(
    options: CountDeliveriesByEndpointOptions
  ): Promise<Map<string, number>>;
  getDelivery(options: GetWebhookDeliveryOptions): Promise<DetailedWebhookDelivery | null>;
}

class WebhookDeliveriesRepository implements IWebhookDeliveriesRepository {
  private readonly clickHouseRepository: ClickHouseWebhookDeliveriesRepository;

  constructor(private readonly options: WebhookDeliveriesRepositoryOptions) {
    this.clickHouseRepository = new ClickHouseWebhookDeliveriesRepository(options);
  }

  async #withRetention<T extends { environmentId: string }>(options: T): Promise<WithRetention<T>> {
    const resolve =
      this.options.retentionDays ??
      (async (environmentId: string) =>
        (await webhookLimitsForEnvironment(environmentId)).deliveryRetentionDays);
    return { ...options, retentionDays: await resolve(options.environmentId) };
  }

  get name() {
    return this.clickHouseRepository.name;
  }

  async listDeliveryIds(options: ListWebhookDeliveriesOptions) {
    return startActiveSpan(
      "webhookDeliveriesRepository.listDeliveryIds",
      async () => this.clickHouseRepository.listDeliveryIds(await this.#withRetention(options)),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async listDeliveries(options: ListWebhookDeliveriesOptions) {
    return startActiveSpan(
      "webhookDeliveriesRepository.listDeliveries",
      async () => this.clickHouseRepository.listDeliveries(await this.#withRetention(options)),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async getDeliveriesByFriendlyIds(options: GetDeliveriesByFriendlyIdsOptions) {
    return startActiveSpan(
      "webhookDeliveriesRepository.getDeliveriesByFriendlyIds",
      async () =>
        this.clickHouseRepository.getDeliveriesByFriendlyIds(await this.#withRetention(options)),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async countDeliveries(options: FilterWebhookDeliveriesOptions) {
    return startActiveSpan(
      "webhookDeliveriesRepository.countDeliveries",
      async () => this.clickHouseRepository.countDeliveries(await this.#withRetention(options)),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async countDeliveriesByEndpoint(options: CountDeliveriesByEndpointOptions) {
    return startActiveSpan(
      "webhookDeliveriesRepository.countDeliveriesByEndpoint",
      async () =>
        this.clickHouseRepository.countDeliveriesByEndpoint(await this.#withRetention(options)),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async getDelivery(options: GetWebhookDeliveryOptions) {
    return startActiveSpan(
      "webhookDeliveriesRepository.getDelivery",
      async () => this.clickHouseRepository.getDelivery(await this.#withRetention(options)),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }
}

// Inline-constructed per request (NOT a module-level singleton), like RunsRepository.
export function webhookDeliveriesRepository(opts: WebhookDeliveriesRepositoryOptions) {
  return new WebhookDeliveriesRepository(opts);
}
