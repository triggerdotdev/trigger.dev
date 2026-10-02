import { type ClickHouse } from "@internal/clickhouse";
import { type PrismaClientOrTransaction, type WebhookDeliveryStatus } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { boundedIn, webhookReplica } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import { type EndpointDeliveryListItem } from "./WebhookDetailPresenter.server";

const DELIVERIES_PAGE_SIZE = 60;
type Direction = "forward" | "backward";

/** A delivery in the environment-wide list, with the endpoint it arrived on. */
export type EnvironmentDeliveryListItem = EndpointDeliveryListItem & {
  endpoint: { id: string; declaredId: string } | null;
};

export type WebhookDeliveriesListResult = {
  deliveries: EnvironmentDeliveryListItem[];
  pagination: { next?: string; previous?: string };
};

/**
 * Every delivery in the environment across its endpoints (the public list API), optionally
 * narrowed to some endpoints. Mirrors WebhookDetailPresenter.listDeliveries plus the endpoint
 * each delivery arrived on.
 */
export class WebhookDeliveriesListPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  async call({
    organizationId,
    projectId,
    environmentId,
    endpoints,
    statuses,
    deliveryId,
    runId,
    isTest,
    period,
    from,
    to,
    cursor,
    direction,
    pageSize,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    /** Declared endpoint ids or `wh_` ids. */
    endpoints?: string[];
    statuses?: WebhookDeliveryStatus[];
    deliveryId?: string;
    runId?: string;
    isTest?: boolean;
    period?: string;
    from?: number;
    to?: number;
    cursor?: string;
    direction?: Direction;
    pageSize?: number;
  }): Promise<WebhookDeliveriesListResult> {
    const periodMs = period ? (parseDuration(period) ?? undefined) : undefined;

    const { webhookEndpointIds, internalRunId } = await this.#resolveFilterScope(
      environmentId,
      endpoints,
      runId
    );

    // Built per request (factory, NOT a singleton), matching every RunsRepository consumer.
    const repository = webhookDeliveriesRepository({
      clickhouse: this.clickhouse,
      prisma: webhookReplica,
    });

    // No webhookEndpointId: all endpoints in the environment.
    const { deliveries, pagination } = await repository.listDeliveries({
      organizationId,
      projectId,
      environmentId,
      webhookEndpointIds,
      deliveryId,
      runId: internalRunId,
      statuses,
      isTest,
      period: periodMs,
      from,
      to,
      page: { size: pageSize ?? DELIVERIES_PAGE_SIZE, cursor, direction },
    });

    const endpointIds = Array.from(new Set(deliveries.map((d) => d.webhookEndpointId)));
    const endpointById = new Map<string, { id: string; declaredId: string }>();
    if (endpointIds.length > 0) {
      const rows = await webhookReplica.webhookEndpoint.findMany({
        where: { id: { in: boundedIn(endpointIds) } },
        select: { id: true, friendlyId: true, declaredId: true },
      });
      for (const e of rows) endpointById.set(e.id, { id: e.friendlyId, declaredId: e.declaredId });
    }

    const items: EnvironmentDeliveryListItem[] = deliveries.map((d) => ({
      id: d.id,
      friendlyId: d.friendlyId,
      externalDeliveryId: d.externalDeliveryId,
      status: d.status,
      isTest: d.isTest,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt,
      processedAt: d.processedAt,
      endpoint: endpointById.get(d.webhookEndpointId) ?? null,
    }));

    return {
      deliveries: items,
      pagination: {
        next: pagination.nextCursor ?? undefined,
        previous: pagination.previousCursor ?? undefined,
      },
    };
  }

  /** Count one endpoint's deliveries newer than `since`, for the live "N new deliveries" pill. */
  async countNewDeliveries({
    organizationId,
    projectId,
    environmentId,
    webhookEndpointId,
    since,
    to,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    webhookEndpointId?: string;
    since: number;
    to?: number;
  }): Promise<number> {
    if (to !== undefined && to <= since) return 0;

    const repository = webhookDeliveriesRepository({
      clickhouse: this.clickhouse,
      prisma: webhookReplica,
    });

    const { deliveryIds } = await repository.listDeliveryIds({
      organizationId,
      projectId,
      environmentId,
      webhookEndpointId,
      from: since + 1,
      to,
      page: { size: 100 },
    });

    return deliveryIds.length;
  }

  /**
   * Resolve the endpoint filter (declared ids or `wh_` ids) to endpoint ids and the friendly runId
   * to the internal id. A non-empty filter that matches nothing resolves to a sentinel that can
   * never match, so the filter returns nothing rather than being dropped.
   */
  async #resolveFilterScope(
    environmentId: string,
    endpoints?: string[],
    runId?: string
  ): Promise<{ webhookEndpointIds?: string[]; internalRunId?: string }> {
    let webhookEndpointIds: string[] | undefined;
    if (endpoints && endpoints.length > 0) {
      const rows = await webhookReplica.webhookEndpoint.findMany({
        where: {
          runtimeEnvironmentId: environmentId,
          OR: [
            { declaredId: { in: boundedIn(endpoints) } },
            { friendlyId: { in: boundedIn(endpoints) } },
          ],
        },
        select: { id: true },
      });
      webhookEndpointIds = rows.length > 0 ? rows.map((e) => e.id) : ["__none__"];
    }

    let internalRunId: string | undefined;
    if (runId) {
      const run = await runStore.findRun(
        { friendlyId: runId },
        { select: { id: true } },
        this.replica
      );
      internalRunId = run?.id ?? "__none__";
    }

    return { webhookEndpointIds, internalRunId };
  }
}
