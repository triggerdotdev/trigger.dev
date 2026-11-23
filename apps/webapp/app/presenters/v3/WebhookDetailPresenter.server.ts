import { type ClickHouse } from "@internal/clickhouse";
import { webhookEndpointSubscribers } from "~/v3/webhookSetupPrompt";
import {
  type Prisma,
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type WebhookDeliveryStatus,
  type WebhookEndpointStatus,
} from "@trigger.dev/database";
import { deliveryActivityBuckets } from "./activitySeries.server";
import parseDuration from "parse-duration";
import { z } from "zod";
import { type Direction } from "~/components/ListPagination";
import {
  type DeliveryListFilters,
  hasDeliveryListFilters,
} from "~/components/webhookDeliveries/v1/deliveryListFilters";
import { boundedIn, webhookReplica } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import {
  buildWebhookComposerEndpoints,
  type WebhookComposerEndpointData,
} from "./webhookComposerEndpoints.server";

type WebhookEndpointSummary = {
  id: string;
  friendlyId: string;
  opaqueId: string;
  declaredId: string;
  source: string;
  status: WebhookEndpointStatus;
  isDefault: boolean;
  tenantId: string | null;
  hasSigningSecret: boolean;
  /** The task's filter on this endpoint, or null when it receives every delivery. */
  filter: string | null;
};

/** An endpoint a webhook() task subscribes to, with the task's filter on it. */
type WebhookTaskEndpoint = WebhookEndpointSummary;

/** A task that subscribes to webhook endpoints (a webhook() task), and those endpoints. */
export type WebhookDetail = {
  slug: string;
  filePath: string;
  createdAt: Date;
  endpoints: WebhookTaskEndpoint[];
};

type DeliveryActivityPoint = {
  bucket: number; // epoch ms
} & Record<string, number>;

/** Deliveries per time bucket by their current status, for the Deliveries tab's chart. */
export type DeliveryActivity = {
  data: DeliveryActivityPoint[];
  /** Every delivery status, in the order the chart stacks them. */
  statuses: WebhookDeliveryStatus[];
  /** Deliveries in the period by status. */
  totals: Partial<Record<WebhookDeliveryStatus, number>>;
  lastDeliveryAt: Date | null;
};

/** A row on an endpoint's Deliveries tab: which runs it reached is on the delivery page. */
export type EndpointDeliveryListItem = {
  id: string;
  friendlyId: string;
  webhookEndpointId: string;
  externalDeliveryId: string;
  status: WebhookDeliveryStatus;
  isTest: boolean;
  errorMessage: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

export type WebhookDeliveriesList = {
  deliveries: EndpointDeliveryListItem[];
  pagination: { next?: string; previous?: string };
  filters: { from?: number; to?: number };
  hasFilters: boolean;
};

/**
 * Resolve delivery run ids (INTERNAL, no FK) to their run friendlyId and, when the run belongs to a
 * chat.agent session, the session it targeted. Shared by the per-endpoint and cross-endpoint lists.
 */
export async function resolveDeliveryRunTargets(
  replica: PrismaClientOrTransaction,
  deliveries: { runId: string | null }[]
): Promise<{
  runFriendlyIdById: Map<string, string>;
  sessionByRunId: Map<string, { friendlyId: string; externalId: string | null }>;
}> {
  const runIds = Array.from(
    new Set(deliveries.map((d) => d.runId).filter((id): id is string => Boolean(id)))
  );
  const runFriendlyIdById = new Map<string, string>();
  const sessionByRunId = new Map<string, { friendlyId: string; externalId: string | null }>();
  if (runIds.length === 0) return { runFriendlyIdById, sessionByRunId };

  const [runs, sessionRuns] = await Promise.all([
    runStore.findRuns(
      { where: { id: { in: boundedIn(runIds) } }, select: { id: true, friendlyId: true } },
      replica
    ),
    replica.sessionRun.findMany({
      where: { runId: { in: boundedIn(runIds) } },
      select: { runId: true, session: { select: { friendlyId: true, externalId: true } } },
    }),
  ]);
  for (const run of runs) runFriendlyIdById.set(run.id, run.friendlyId);
  for (const sr of sessionRuns) sessionByRunId.set(sr.runId, sr.session);
  return { runFriendlyIdById, sessionByRunId };
}

export type WebhookEndpointDetail = {
  id: string;
  friendlyId: string;
  opaqueId: string;
  declaredId: string;
  source: string;
  status: WebhookEndpointStatus;
  isDefault: boolean;
  tenantId: string;
  externalRef: string;
  hasSigningSecret: boolean;
  // "provider" | "integrator" | "either" — drives the Connect UI (paste vs generate).
  secretProvisioning: string;
  // Tagged-union JSON parsed by the route with the @trigger.dev/core schemas.
  routingTargets: Prisma.JsonValue;
  verifierArtifact: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

/** The order the deliveries chart stacks statuses, bottom first. */
const DELIVERY_STATUS_ORDER: WebhookDeliveryStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "PROCESSING",
  "PENDING",
  "FILTERED",
  "UNMATCHED",
];

const DELIVERIES_PAGE_SIZE = 25;

/** The endpoints in an environment that route to a webhook() task. */
function taskEndpointsWhere(environmentId: string, webhookSlug: string) {
  return {
    runtimeEnvironmentId: environmentId,
    routingTargets: { array_contains: [{ type: "task", taskId: webhookSlug }] },
    status: { not: "DELETING" },
  } satisfies Prisma.WebhookEndpointWhereInput;
}

export class WebhookDetailPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  /** A webhook() task on the environment's current worker, with the endpoints it subscribes to. */
  async findWebhook({
    environmentId,
    environmentType,
    webhookSlug,
  }: {
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
    webhookSlug: string;
  }): Promise<WebhookDetail | null> {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      { id: environmentId, type: environmentType },
      this.replica
    );
    if (!currentWorker) return null;

    const task = await this.replica.backgroundWorkerTask.findFirst({
      where: { workerId: currentWorker.id, slug: webhookSlug },
      select: { slug: true, filePath: true, createdAt: true },
    });
    if (!task) return null;

    return { ...task, endpoints: await this.findTaskEndpoints({ environmentId, webhookSlug }) };
  }

  /** The endpoints a webhook() task subscribes to in this environment. */
  async findTaskEndpoints({
    environmentId,
    webhookSlug,
  }: {
    environmentId: string;
    webhookSlug: string;
  }): Promise<WebhookTaskEndpoint[]> {
    const endpoints = await webhookReplica.webhookEndpoint.findMany({
      where: taskEndpointsWhere(environmentId, webhookSlug),
      select: {
        id: true,
        friendlyId: true,
        opaqueId: true,
        declaredId: true,
        source: true,
        status: true,
        endpointTenantId: true,
        endpointExternalRef: true,
        // signingSecretKey is selected ONLY to derive hasSigningSecret below.
        // The secret value never leaves this method.
        signingSecretKey: true,
        routingTargets: true,
      },
      orderBy: [{ declaredId: "asc" }, { endpointTenantId: "asc" }, { createdAt: "desc" }],
    });

    return endpoints.map((endpoint) => ({
      id: endpoint.id,
      friendlyId: endpoint.friendlyId,
      opaqueId: endpoint.opaqueId,
      declaredId: endpoint.declaredId,
      source: endpoint.source,
      status: endpoint.status,
      isDefault: endpoint.endpointTenantId === "" && endpoint.endpointExternalRef === "",
      tenantId: endpoint.endpointTenantId || null,
      hasSigningSecret: endpoint.signingSecretKey != null && endpoint.signingSecretKey !== "",
      filter:
        webhookEndpointSubscribers(endpoint.routingTargets).find(
          (subscriber) => subscriber.type === "task" && subscriber.taskId === webhookSlug
        )?.filter ?? null,
    }));
  }

  /** Only the ids of those endpoints, for the live count of a task's new deliveries. */
  async findTaskEndpointIds({
    environmentId,
    webhookSlug,
  }: {
    environmentId: string;
    webhookSlug: string;
  }): Promise<string[]> {
    const endpoints = await webhookReplica.webhookEndpoint.findMany({
      where: taskEndpointsWhere(environmentId, webhookSlug),
      select: { id: true },
    });
    return endpoints.map((endpoint) => endpoint.id);
  }

  async listComposerEndpoints({
    environmentId,
    declaredId,
  }: {
    environmentId: string;
    declaredId: string;
  }): Promise<WebhookComposerEndpointData[]> {
    const endpoints = await webhookReplica.webhookEndpoint.findMany({
      where: { runtimeEnvironmentId: environmentId, declaredId },
      select: {
        friendlyId: true,
        opaqueId: true,
        source: true,
        endpointTenantId: true,
        endpointExternalRef: true,
        verifierArtifact: true,
        signingSecretKey: true,
      },
      orderBy: [{ endpointTenantId: "asc" }, { createdAt: "desc" }],
    });
    return buildWebhookComposerEndpoints(endpoints);
  }

  async findEndpoint({
    environmentId,
    endpointFriendlyId,
  }: {
    environmentId: string;
    endpointFriendlyId: string;
  }): Promise<WebhookEndpointDetail | null> {
    const endpoint = await webhookReplica.webhookEndpoint.findFirst({
      // friendlyId is globally unique, but scope to the env so a foreign id 404s.
      where: { friendlyId: endpointFriendlyId, runtimeEnvironmentId: environmentId },
      select: {
        id: true,
        friendlyId: true,
        opaqueId: true,
        declaredId: true,
        source: true,
        status: true,
        endpointTenantId: true,
        endpointExternalRef: true,
        signingSecretKey: true,
        secretProvisioning: true,
        routingTargets: true,
        verifierArtifact: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!endpoint) return null;

    return {
      id: endpoint.id,
      friendlyId: endpoint.friendlyId,
      opaqueId: endpoint.opaqueId,
      declaredId: endpoint.declaredId,
      source: endpoint.source,
      status: endpoint.status,
      isDefault: endpoint.endpointTenantId === "" && endpoint.endpointExternalRef === "",
      tenantId: endpoint.endpointTenantId,
      externalRef: endpoint.endpointExternalRef,
      hasSigningSecret: endpoint.signingSecretKey != null && endpoint.signingSecretKey !== "",
      secretProvisioning: endpoint.secretProvisioning,
      routingTargets: endpoint.routingTargets,
      verifierArtifact: endpoint.verifierArtifact,
      metadata: endpoint.metadata,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    };
  }

  /**
   * Deliveries to some endpoints per time bucket, by current status. A delivery has one row per
   * status it passed through, so its current status is `argMax(status, _version)` before counting
   * (as the endpoints list's activity does).
   */
  async getDeliveryActivity({
    organizationId,
    projectId,
    environmentId,
    webhookEndpointIds,
    from,
    to,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    webhookEndpointIds: string[];
    from: Date;
    to: Date;
  }): Promise<DeliveryActivity> {
    const {
      bucketSeconds,
      bucketMs,
      start,
      end,
      from: rangeFrom,
    } = deliveryActivityBuckets(from, to);
    const buckets = new Map<number, Record<string, number>>();
    const totals: DeliveryActivity["totals"] = {};
    let lastDeliveryMs = 0;

    if (webhookEndpointIds.length > 0) {
      const queryFn = this.clickhouse.reader.query({
        name: "webhookDeliveryStatusActivity",
        query: `SELECT
            toUnixTimestamp(toStartOfInterval(delivery_created_at, INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
            current_status AS status,
            count() AS val,
            toUnixTimestamp64Milli(max(delivery_created_at)) AS last_ms
          FROM (
            SELECT delivery_id, argMax(status, _version) AS current_status, max(created_at) AS delivery_created_at
            FROM trigger_dev.webhook_deliveries_v2
            WHERE organization_id = {organizationId: String}
              AND project_id = {projectId: String}
              AND environment_id = {environmentId: String}
              AND webhook_endpoint_id IN {webhookEndpointIds: Array(String)}
              AND created_at >= fromUnixTimestamp64Milli({fromMs: Int64})
              AND created_at < fromUnixTimestamp64Milli({toMs: Int64})
            GROUP BY delivery_id
            HAVING argMax(_is_deleted, _version) = 0
          )
          GROUP BY bucket, status
          ORDER BY bucket`,
        params: z.object({
          organizationId: z.string(),
          projectId: z.string(),
          environmentId: z.string(),
          webhookEndpointIds: z.array(z.string()),
          bucketSeconds: z.number(),
          fromMs: z.number(),
          toMs: z.number(),
        }),
        schema: z.object({
          bucket: z.coerce.number(),
          status: z.string(),
          val: z.coerce.number(),
          last_ms: z.coerce.number(),
        }),
      });

      const [error, rows] = await queryFn({
        organizationId,
        projectId,
        environmentId,
        webhookEndpointIds,
        bucketSeconds,
        fromMs: rangeFrom.getTime(),
        toMs: to.getTime(),
      });
      if (error) throw error;

      for (const row of rows) {
        const status = row.status as WebhookDeliveryStatus;
        const ts = row.bucket * 1000;
        const existing = buckets.get(ts) ?? {};
        existing[status] = (existing[status] ?? 0) + row.val;
        buckets.set(ts, existing);
        totals[status] = (totals[status] ?? 0) + row.val;
        lastDeliveryMs = Math.max(lastDeliveryMs, row.last_ms);
      }
    }

    const data: DeliveryActivityPoint[] = [];
    for (let ts = start; ts < end; ts += bucketMs) {
      const existing = buckets.get(ts) ?? {};
      const point: DeliveryActivityPoint = { bucket: ts };
      for (const status of DELIVERY_STATUS_ORDER) point[status] = existing[status] ?? 0;
      data.push(point);
    }

    return {
      data,
      statuses: DELIVERY_STATUS_ORDER,
      totals,
      lastDeliveryAt: lastDeliveryMs > 0 ? new Date(lastDeliveryMs) : null,
    };
  }

  async listDeliveries({
    organizationId,
    projectId,
    environmentId,
    webhookEndpointIds,
    period,
    from,
    to,
    hasExplicitWindow,
    filters = {},
    cursor,
    direction,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    /** The endpoints to list; an empty list returns nothing. */
    webhookEndpointIds: string[];
    period?: string;
    from?: number;
    to?: number;
    hasExplicitWindow?: boolean;
    filters?: DeliveryListFilters;
    cursor?: string;
    direction?: Direction;
  }): Promise<WebhookDeliveriesList> {
    const periodMs = period ? (parseDuration(period) ?? undefined) : undefined;

    // Built per request (factory, NOT a singleton), matching every RunsRepository consumer.
    const repository = webhookDeliveriesRepository({
      clickhouse: this.clickhouse,
      prisma: webhookReplica,
    });

    const { deliveries, pagination } = await repository.listDeliveries({
      organizationId,
      projectId,
      environmentId,
      // A sentinel that never matches, so no endpoints means no deliveries rather than all of them.
      webhookEndpointIds: webhookEndpointIds.length > 0 ? webhookEndpointIds : ["__none__"],
      statuses: filters.statuses,
      isTest: filters.isTest,
      deliveryId: filters.deliveryId,
      period: periodMs,
      from,
      to,
      page: { size: DELIVERIES_PAGE_SIZE, cursor, direction },
    });

    const items: EndpointDeliveryListItem[] = deliveries.map((d) => ({
      id: d.id,
      friendlyId: d.friendlyId,
      webhookEndpointId: d.webhookEndpointId,
      externalDeliveryId: d.externalDeliveryId,
      status: d.status,
      isTest: d.isTest,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt,
      processedAt: d.processedAt,
    }));

    return {
      deliveries: items,
      pagination: {
        next: pagination.nextCursor ?? undefined,
        previous: pagination.previousCursor ?? undefined,
      },
      filters: { from, to },
      hasFilters: (hasExplicitWindow ?? Boolean(from || to)) || hasDeliveryListFilters(filters),
    };
  }
}
