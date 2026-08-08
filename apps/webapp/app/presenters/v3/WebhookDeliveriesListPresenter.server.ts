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

    // Resolve the handler-slug webhook filter to endpoint ids. A non-empty webhook
    // filter that matches no endpoints must return nothing, so fall back to a
    // sentinel id that can never match rather than dropping the filter entirely.
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

    // The runId param is a FRIENDLY run id; the deliveries store the INTERNAL id.
    // Resolve it, and force empty results when no run matches.
    let internalRunId: string | undefined;
    if (runId) {
      const run = await runStore.findRun(
        { friendlyId: runId },
        { select: { id: true } },
        this.replica
      );
      internalRunId = run?.id ?? "__none__";
    }

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
}
