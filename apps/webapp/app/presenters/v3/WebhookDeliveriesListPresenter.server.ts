import { type ClickHouse } from "@internal/clickhouse";
import { type PrismaClientOrTransaction, type WebhookDeliveryStatus } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { boundedIn, webhookReplica } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import {
  resolveDeliveryRunTargets,
  type WebhookDeliveryListItem,
} from "./WebhookDetailPresenter.server";

const DELIVERIES_PAGE_SIZE = 60;
type Direction = "forward" | "backward";

export type WebhookDeliveriesListResult = {
  deliveries: WebhookDeliveryListItem[];
  pagination: { next?: string; previous?: string };
};

/**
 * The top-level (cross-endpoint) deliveries list: every delivery in the environment,
 * across all webhook endpoints/handlers. Mirrors WebhookDetailPresenter.listDeliveries but
 * with no webhookEndpointId filter, plus it hydrates which webhook each delivery belongs to
 * for the table's Webhook column.
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
    webhooks,
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
    webhooks?: string[];
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
      webhooks,
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

    // Resolve run friendlyIds (the runId is the INTERNAL id; the table links by friendlyId) and, for
    // session deliveries, the session the run belongs to.
    const { runFriendlyIdById, sessionByRunId } = await resolveDeliveryRunTargets(
      this.replica,
      deliveries
    );

    // Resolve which webhook (handler) each delivery belongs to for the Webhook column.
    const endpointIds = Array.from(new Set(deliveries.map((d) => d.webhookEndpointId)));
    const endpointById = new Map<string, { slug: string; source: string }>();
    if (endpointIds.length > 0) {
      const endpoints = await webhookReplica.webhookEndpoint.findMany({
        where: { id: { in: boundedIn(endpointIds) } },
        select: { id: true, handlerWebhookId: true, source: true },
      });
      for (const e of endpoints) {
        endpointById.set(e.id, { slug: e.handlerWebhookId, source: e.source });
      }
    }

    const items: WebhookDeliveryListItem[] = deliveries.map((d) => {
      const friendlyId = d.runId ? runFriendlyIdById.get(d.runId) : undefined;
      return {
        id: d.id,
        friendlyId: d.friendlyId,
        externalDeliveryId: d.externalDeliveryId,
        status: d.status,
        isTest: d.isTest,
        runId: d.runId,
        run: friendlyId ? { friendlyId } : null,
        session: d.runId ? (sessionByRunId.get(d.runId) ?? null) : null,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt,
        processedAt: d.processedAt,
        webhook: endpointById.get(d.webhookEndpointId) ?? null,
      };
    });

    return {
      deliveries: items,
      pagination: {
        next: pagination.nextCursor ?? undefined,
        previous: pagination.previousCursor ?? undefined,
      },
    };
  }

  /**
   * Count deliveries newer than `since` that match the same filters the list is showing, for the
   * live "N new deliveries" badge. Applies the same filter resolution as {@link call} so the badge
   * never counts events the filtered list would exclude. `webhookEndpointId` scopes to a single
   * endpoint (the per-webhook page); `webhooks` is the cross-endpoint handler filter.
   */
  async countNewDeliveries({
    organizationId,
    projectId,
    environmentId,
    webhookEndpointId,
    webhooks,
    statuses,
    deliveryId,
    runId,
    isTest,
    since,
    to,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    webhookEndpointId?: string;
    webhooks?: string[];
    statuses?: WebhookDeliveryStatus[];
    deliveryId?: string;
    runId?: string;
    isTest?: boolean;
    since: number;
    to?: number;
  }): Promise<number> {
    if (to !== undefined && to <= since) return 0;

    const { webhookEndpointIds, internalRunId } = await this.#resolveFilterScope(
      environmentId,
      webhooks,
      runId
    );

    const repository = webhookDeliveriesRepository({
      clickhouse: this.clickhouse,
      prisma: webhookReplica,
    });

    const { deliveryIds } = await repository.listDeliveryIds({
      organizationId,
      projectId,
      environmentId,
      webhookEndpointId,
      webhookEndpointIds,
      deliveryId,
      runId: internalRunId,
      statuses,
      isTest,
      from: since + 1,
      to,
      page: { size: 100 },
    });

    return deliveryIds.length;
  }

  /**
   * Resolve the handler-slug webhook filter to endpoint ids and the friendly runId to the internal
   * id. A non-empty filter that matches nothing resolves to a sentinel that can never match, so the
   * filter returns nothing rather than being dropped.
   */
  async #resolveFilterScope(
    environmentId: string,
    webhooks?: string[],
    runId?: string
  ): Promise<{ webhookEndpointIds?: string[]; internalRunId?: string }> {
    let webhookEndpointIds: string[] | undefined;
    if (webhooks && webhooks.length > 0) {
      const endpoints = await webhookReplica.webhookEndpoint.findMany({
        where: {
          runtimeEnvironmentId: environmentId,
          handlerWebhookId: { in: boundedIn(webhooks) },
        },
        select: { id: true },
      });
      webhookEndpointIds = endpoints.length > 0 ? endpoints.map((e) => e.id) : ["__none__"];
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
