import { type ClickHouse } from "@internal/clickhouse";
import { webhookEndpointSubscribers } from "~/v3/webhookSetupPrompt";
import {
  type Prisma,
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type WebhookDeliveryStatus,
  type WebhookEndpointStatus,
} from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { z } from "zod";
import { type Direction } from "~/components/ListPagination";
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

/** A task that subscribes to webhook endpoints (a webhook() task), and those endpoints. */
export type WebhookDetail = {
  slug: string;
  filePath: string;
  createdAt: Date;
  endpoints: WebhookEndpointSummary[];
};

type WebhookActivityPoint = {
  bucket: number; // epoch ms
} & Record<string, number>;

export type WebhookActivity = {
  data: WebhookActivityPoint[];
  statuses: string[];
};

/** A row on an endpoint's Deliveries tab: which runs it reached is on the delivery page. */
export type EndpointDeliveryListItem = {
  id: string;
  friendlyId: string;
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

// Run-status group order, shared with getRunActivity. Mirrors AgentDetailPresenter.
const TERMINAL_GROUPS = {
  COMPLETED: ["COMPLETED_SUCCESSFULLY"],
  FAILED: ["COMPLETED_WITH_ERRORS", "SYSTEM_FAILURE", "CRASHED", "INTERRUPTED", "TIMED_OUT"],
  CANCELED: ["CANCELED", "EXPIRED"],
  RUNNING: [
    "EXECUTING",
    "DEQUEUED",
    "PENDING_EXECUTING",
    "WAITING_TO_RESUME",
    "QUEUED_EXECUTING",
    "PENDING",
    "PENDING_VERSION",
    "DELAYED",
    "WAITING_FOR_DEPLOY",
  ],
} as const;

const GROUP_LABEL = ["COMPLETED", "FAILED", "CANCELED", "RUNNING"] as const;
type GroupLabel = (typeof GROUP_LABEL)[number];

function groupForStatus(status: string): GroupLabel | undefined {
  for (const label of GROUP_LABEL) {
    if ((TERMINAL_GROUPS[label] as readonly string[]).includes(status)) return label;
  }
  return undefined;
}

const DELIVERIES_PAGE_SIZE = 25;

export class WebhookDetailPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

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
      where: {
        workerId: currentWorker.id,
        slug: webhookSlug,
      },
      select: {
        slug: true,
        filePath: true,
        createdAt: true,
      },
    });

    if (!task) return null;

    const endpoints = await webhookReplica.webhookEndpoint.findMany({
      where: {
        runtimeEnvironmentId: environmentId,
        routingTargets: { array_contains: [{ type: "task", taskId: webhookSlug }] },
        status: { not: "DELETING" },
      },
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

    return {
      slug: task.slug,
      filePath: task.filePath,
      createdAt: task.createdAt,
      endpoints: endpoints.map((endpoint) => ({
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
      })),
    };
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

  async getRunActivity({
    organizationId,
    projectId,
    environmentId,
    webhookSlug,
    from,
    to,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    webhookSlug: string;
    from: Date;
    to: Date;
  }): Promise<WebhookActivity> {
    const rangeMs = Math.max(1, to.getTime() - from.getTime());
    const oneHour = 60 * 60 * 1000;
    const oneDay = 24 * oneHour;

    const bucketSeconds =
      rangeMs <= oneDay ? 60 * 60 : rangeMs <= 7 * oneDay ? 6 * 60 * 60 : 24 * 60 * 60;

    // FINAL + _is_deleted = 0 because task_runs_v2 is a ReplacingMergeTree;
    // org/project filters engage the sort-key prefix for partition pruning.
    const queryFn = this.clickhouse.reader.query({
      name: "webhookRunStatusActivity",
      query: `SELECT
          toUnixTimestamp(toStartOfInterval(created_at, INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
          status,
          count() AS val
        FROM trigger_dev.task_runs_v2 FINAL
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_identifier = {webhookSlug: String}
          AND created_at >= {fromTime: DateTime64(3, 'UTC')}
          AND created_at < {toTime: DateTime64(3, 'UTC')}
          AND _is_deleted = 0
        GROUP BY bucket, status
        ORDER BY bucket`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        webhookSlug: z.string(),
        bucketSeconds: z.number(),
        fromTime: z.string(),
        toTime: z.string(),
      }),
      schema: z.object({
        bucket: z.coerce.number(),
        status: z.string(),
        val: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({
      organizationId,
      projectId,
      environmentId,
      webhookSlug,
      bucketSeconds,
      // ClickHouse's DateTime64(3, 'UTC') parser rejects the trailing `Z` from
      // JS toISOString(). Strip it.
      fromTime: from.toISOString().slice(0, -1),
      toTime: to.toISOString().slice(0, -1),
    });

    if (error) {
      console.error("Webhook run activity query failed:", error);
      return { data: [], statuses: [] };
    }

    const bucketMap = new Map<number, Record<string, number>>();
    for (const row of rows) {
      const group = groupForStatus(row.status) ?? "RUNNING";
      const ts = row.bucket * 1000;
      const existing = bucketMap.get(ts) ?? {};
      existing[group] = (existing[group] ?? 0) + row.val;
      bucketMap.set(ts, existing);
    }

    const bucketMs = bucketSeconds * 1000;
    const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
    const end = Math.ceil(to.getTime() / bucketMs) * bucketMs;
    const points: WebhookActivityPoint[] = [];
    const orderedStatuses = [...GROUP_LABEL];
    for (let ts = start; ts < end; ts += bucketMs) {
      const existing = bucketMap.get(ts) ?? {};
      const point: WebhookActivityPoint = { bucket: ts };
      for (const g of orderedStatuses) {
        point[g] = existing[g] ?? 0;
      }
      points.push(point);
    }

    return { data: points, statuses: orderedStatuses };
  }

  async listDeliveries({
    organizationId,
    projectId,
    environmentId,
    webhookEndpointId,
    period,
    from,
    to,
    hasExplicitWindow,
    cursor,
    direction,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    webhookEndpointId?: string;
    period?: string;
    from?: number;
    to?: number;
    hasExplicitWindow?: boolean;
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
      webhookEndpointId,
      period: periodMs,
      from,
      to,
      page: { size: DELIVERIES_PAGE_SIZE, cursor, direction },
    });

    const items: EndpointDeliveryListItem[] = deliveries.map((d) => ({
      id: d.id,
      friendlyId: d.friendlyId,
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
      hasFilters: hasExplicitWindow ?? Boolean(from || to),
    };
  }
}
