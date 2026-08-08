import { type ClickHouse } from "@internal/clickhouse";
import {
  type Prisma,
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type WebhookDeliveryStatus,
} from "@trigger.dev/database";
import { webhookReplica } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";

export type WebhookDeliveryDetail = {
  id: string;
  friendlyId: string;
  status: WebhookDeliveryStatus;
  externalDeliveryId: string;
  idempotencyKey: string;
  rawBodyHash: string | null;
  parsedEvent: Prisma.JsonValue | null;
  headers: Prisma.JsonValue | null;
  errorMessage: string | null;
  filterReason: string | null;
  environmentType: RuntimeEnvironmentType;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
  // Resolved from the run id (deliveries store the INTERNAL id; the UI links by friendlyId).
  run: { friendlyId: string } | null;
  // Set when the run belongs to a chat.agent session (the delivery routed to a session); the session
  // is the meaningful target, so the UI links it instead of the incidental run.
  session: { friendlyId: string; externalId: string | null } | null;
  // The handler webhook this delivery routed to.
  webhook: { slug: string; source: string } | null;
};

/**
 * A single webhook delivery, by its friendlyId. ClickHouse resolves the friendlyId
 * to (id, createdAt) for a partition-pruned Postgres point lookup, then this hydrates
 * the run friendlyId and the handler webhook for the detail view.
 */
export class WebhookDeliveryDetailPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  async call({
    organizationId,
    projectId,
    environmentId,
    deliveryFriendlyId,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    deliveryFriendlyId: string;
  }): Promise<WebhookDeliveryDetail | null> {
    const repository = webhookDeliveriesRepository({
      clickhouse: this.clickhouse,
      prisma: webhookReplica,
    });

    const delivery = await repository.getDelivery({
      organizationId,
      projectId,
      environmentId,
      friendlyId: deliveryFriendlyId,
    });

    if (!delivery) {
      return null;
    }

    // Defense in depth: getDelivery is already env-scoped via ClickHouse, but the
    // Postgres row is the source of truth, so confirm it belongs to this environment.
    if (delivery.runtimeEnvironmentId !== environmentId) {
      return null;
    }

    let run: { friendlyId: string } | null = null;
    let session: { friendlyId: string; externalId: string | null } | null = null;
    if (delivery.runId) {
      const [taskRun, sessionRun] = await Promise.all([
        runStore.findRun({ id: delivery.runId }, { select: { friendlyId: true } }, this.replica),
        this.replica.sessionRun.findUnique({
          where: { runId: delivery.runId },
          select: { session: { select: { friendlyId: true, externalId: true } } },
        }),
      ]);
      run = taskRun ? { friendlyId: taskRun.friendlyId } : null;
      session = sessionRun?.session ?? null;
    }

    const endpoint = await webhookReplica.webhookEndpoint.findFirst({
      where: { id: delivery.webhookEndpointId },
      select: { handlerWebhookId: true, source: true },
    });
    const webhook = endpoint ? { slug: endpoint.handlerWebhookId, source: endpoint.source } : null;

    return {
      id: delivery.id,
      friendlyId: delivery.friendlyId,
      status: delivery.status,
      externalDeliveryId: delivery.externalDeliveryId,
      idempotencyKey: delivery.idempotencyKey,
      rawBodyHash: delivery.rawBodyHash,
      parsedEvent: delivery.parsedEvent,
      headers: delivery.headers,
      errorMessage: delivery.errorMessage,
      filterReason: delivery.filterReason,
      environmentType: delivery.environmentType,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      processedAt: delivery.processedAt,
      run,
      session,
      webhook,
    };
  }
}
