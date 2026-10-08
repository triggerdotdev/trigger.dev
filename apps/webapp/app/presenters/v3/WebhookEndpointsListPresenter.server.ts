import { type ClickHouse } from "@internal/clickhouse";
import type { WebhookDeliveryStatus } from "@trigger.dev/database";
import { z } from "zod";
import { type Direction } from "~/components/ListPagination";
import { logger } from "~/services/logger.server";

export const ENDPOINT_STATUS_FILTERS = ["active", "inactive", "disabled"] as const;
export type EndpointStatusFilter = (typeof ENDPOINT_STATUS_FILTERS)[number];

export type WebhookEndpointsListItem = {
  id: string;
  friendlyId: string;
  opaqueId: string;
  declaredId: string;
  tenantId: string | null;
  externalRef: string | null;
  source: string;
  status: "ACTIVE" | "INACTIVE" | "DISABLED";
  hasSigningSecret: boolean;
};

/** One hour of deliveries, counted by current status (sparse: only statuses that occurred). */
export type EndpointActivityBucket = { date: Date; total: number } & Partial<
  Record<WebhookDeliveryStatus, number>
>;

/** 24 hourly buckets ending at the current hour, plus the latest delivery, keyed by endpoint id. */
export type EndpointActivity = Record<
  string,
  { buckets: EndpointActivityBucket[]; lastDeliveryAt: Date | null }
>;

export type WebhookEndpointsList = {
  endpoints: WebhookEndpointsListItem[];
  activity: Promise<EndpointActivity>;
  pagination: { next?: string; previous?: string };
  filterOptions: { subscribers: string[]; sources: string[] };
  hasFilters: boolean;
  hasAnyEndpoints: boolean;
};

const PAGE_SIZE = 50;

const EndpointRow = z.object({
  endpoint_id: z.string(),
  friendly_id: z.string(),
  opaque_id: z.string(),
  declared_id: z.string(),
  endpoint_tenant_id: z.string(),
  endpoint_external_ref: z.string(),
  source: z.string(),
  status: z.string(),
  manually_deactivated: z.coerce.number(),
  has_signing_secret: z.coerce.number(),
});

const ActivityRow = z.object({
  webhook_endpoint_id: z.string(),
  bucket_ms: z.coerce.number(),
  status: z.string(),
  val: z.coerce.number(),
  last_delivery_ms: z.coerce.number(),
});

const Cursor = z.tuple([z.string(), z.string(), z.string(), z.string()]);

function encodeCursor(row: z.infer<typeof EndpointRow>): string {
  return Buffer.from(
    JSON.stringify([
      row.declared_id,
      row.endpoint_tenant_id,
      row.endpoint_external_ref,
      row.endpoint_id,
    ])
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): z.infer<typeof Cursor> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The environment's webhook endpoints, read from the ClickHouse replica of `WebhookEndpoint` so
 * filtering and tenant search scale to per-tenant endpoints. Rows are ordered by declared endpoint id
 * (so instances of one declared endpoint sit together) and paged by that sort key. The page's hourly
 * delivery activity comes from one grouped query over the last 24 hours, returned unawaited so the
 * table renders before it.
 */
export class WebhookEndpointsListPresenter {
  constructor(private readonly clickhouse: ClickHouse) {}

  async call(params: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    subscribers?: string[];
    sources?: string[];
    statuses?: EndpointStatusFilter[];
    search?: string;
    cursor?: string;
    direction?: Direction;
  }): Promise<WebhookEndpointsList> {
    const scope = {
      organizationId: params.organizationId,
      projectId: params.projectId,
      environmentId: params.environmentId,
    };
    const statuses = params.statuses?.length ? params.statuses : (["active"] as const);
    const search = params.search?.trim().toLowerCase() ?? "";
    const cursor = decodeCursor(params.cursor);
    const backward = params.direction === "backward" && cursor !== undefined;

    const statusClauses = statuses.map((status) =>
      status === "active"
        ? "status = 'ACTIVE'"
        : status === "inactive"
          ? "(status = 'INACTIVE' AND manually_deactivated = 0)"
          : "manually_deactivated = 1"
    );

    const where = [
      "organization_id = {organizationId: String}",
      "project_id = {projectId: String}",
      "environment_id = {environmentId: String}",
      "_is_deleted = 0",
      "status != 'DELETING'",
      `(${statusClauses.join(" OR ")})`,
      ...(params.sources?.length ? ["source IN {sources: Array(String)}"] : []),
      ...(params.subscribers?.length
        ? ["hasAny(subscriber_ids, {subscribers: Array(String)})"]
        : []),
      ...(search
        ? [
            "(lower(endpoint_tenant_id) LIKE {pattern: String} OR lower(endpoint_external_ref) LIKE {pattern: String} OR lower(declared_id) LIKE {pattern: String})",
          ]
        : []),
      ...(cursor
        ? [
            `(declared_id, endpoint_tenant_id, endpoint_external_ref, endpoint_id) ${backward ? "<" : ">"} ({c0: String}, {c1: String}, {c2: String}, {c3: String})`,
          ]
        : []),
    ];
    const order = ["declared_id", "endpoint_tenant_id", "endpoint_external_ref", "endpoint_id"]
      .map((column) => `${column} ${backward ? "DESC" : "ASC"}`)
      .join(", ");

    const listQuery = this.clickhouse.reader.query({
      name: "webhookEndpointsList",
      query: `SELECT endpoint_id, friendly_id, opaque_id, declared_id, endpoint_tenant_id, endpoint_external_ref,
          source, status, manually_deactivated, has_signing_secret
        FROM trigger_dev.webhook_endpoints_v1 FINAL
        WHERE ${where.join(" AND ")}
        ORDER BY ${order}
        LIMIT {limit: UInt32}`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        sources: z.array(z.string()).optional(),
        subscribers: z.array(z.string()).optional(),
        pattern: z.string().optional(),
        c0: z.string().optional(),
        c1: z.string().optional(),
        c2: z.string().optional(),
        c3: z.string().optional(),
        limit: z.number(),
      }),
      schema: EndpointRow,
    });

    const [listError, fetched] = await listQuery({
      ...scope,
      ...(params.sources?.length ? { sources: params.sources } : {}),
      ...(params.subscribers?.length ? { subscribers: params.subscribers } : {}),
      ...(search ? { pattern: `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` } : {}),
      ...(cursor ? { c0: cursor[0], c1: cursor[1], c2: cursor[2], c3: cursor[3] } : {}),
      limit: PAGE_SIZE + 1,
    });
    if (listError) throw listError;

    const hasMore = fetched.length > PAGE_SIZE;
    const page = fetched.slice(0, PAGE_SIZE);
    if (backward) page.reverse();

    const activity = this.#activity(
      scope,
      page.map((row) => row.endpoint_id)
    );
    const filterOptions = await this.#filterOptions(scope);

    const endpoints: WebhookEndpointsListItem[] = page.map((row) => {
      return {
        id: row.endpoint_id,
        friendlyId: row.friendly_id,
        opaqueId: row.opaque_id,
        declaredId: row.declared_id,
        tenantId: row.endpoint_tenant_id || null,
        externalRef: row.endpoint_external_ref || null,
        source: row.source,
        status:
          row.manually_deactivated === 1
            ? "DISABLED"
            : row.status === "ACTIVE"
              ? "ACTIVE"
              : "INACTIVE",
        hasSigningSecret: row.has_signing_secret === 1,
      };
    });

    const first = page[0];
    const last = page[page.length - 1];
    const hasNext = backward ? cursor !== undefined : hasMore;
    const hasPrevious = backward ? hasMore : cursor !== undefined;

    return {
      endpoints,
      activity,
      pagination: {
        next: hasNext && last ? encodeCursor(last) : undefined,
        previous: hasPrevious && first ? encodeCursor(first) : undefined,
      },
      filterOptions,
      hasFilters: Boolean(
        params.subscribers?.length || params.sources?.length || params.statuses?.length || search
      ),
      hasAnyEndpoints: endpoints.length > 0 || filterOptions.sources.length > 0,
    };
  }

  /**
   * Hourly delivery counts per endpoint and status for one page over the last 24 hours. A delivery has
   * one row per status it passed through, so its current status is `argMax(status, _version)` before
   * counting. The lower bound is aligned to the hour so exactly 24 buckets come back.
   */
  async #activity(
    scope: { organizationId: string; projectId: string; environmentId: string },
    endpointIds: string[]
  ): Promise<EndpointActivity> {
    const hourMs = 3_600_000;
    const firstBucketMs = Math.floor(Date.now() / hourMs) * hourMs - 23 * hourMs;
    const emptyBuckets = () =>
      Array.from({ length: 24 }, (_, i) => ({
        date: new Date(firstBucketMs + i * hourMs),
        total: 0,
      })) as EndpointActivityBucket[];

    const result: EndpointActivity = {};
    for (const id of endpointIds) result[id] = { buckets: emptyBuckets(), lastDeliveryAt: null };
    if (endpointIds.length === 0) return result;

    const query = this.clickhouse.reader.query({
      name: "webhookEndpointsActivity",
      query: `SELECT webhook_endpoint_id,
          toUnixTimestamp(toStartOfHour(delivery_created_at)) * 1000 AS bucket_ms,
          current_status AS status,
          count() AS val,
          toUnixTimestamp64Milli(max(delivery_created_at)) AS last_delivery_ms
        FROM (
          SELECT webhook_endpoint_id, delivery_id, argMax(status, _version) AS current_status, max(created_at) AS delivery_created_at
          FROM trigger_dev.webhook_deliveries_v2
          WHERE organization_id = {organizationId: String}
            AND project_id = {projectId: String}
            AND environment_id = {environmentId: String}
            AND created_at >= fromUnixTimestamp64Milli({fromMs: Int64})
            AND webhook_endpoint_id IN {endpointIds: Array(String)}
          GROUP BY webhook_endpoint_id, delivery_id
          HAVING argMax(_is_deleted, _version) = 0
        )
        GROUP BY webhook_endpoint_id, bucket_ms, status`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        fromMs: z.number(),
        endpointIds: z.array(z.string()),
      }),
      schema: ActivityRow,
    });

    const [error, rows] = await query({ ...scope, fromMs: firstBucketMs, endpointIds });
    if (error) {
      logger.warn("Webhook endpoint activity query failed", { error });
      return result;
    }
    for (const row of rows) {
      const entry = result[row.webhook_endpoint_id];
      const bucket = entry?.buckets[Math.round((row.bucket_ms - firstBucketMs) / hourMs)];
      if (!entry || !bucket) continue;
      const status = row.status as WebhookDeliveryStatus;
      bucket[status] = (bucket[status] ?? 0) + row.val;
      bucket.total += row.val;
      if (!entry.lastDeliveryAt || row.last_delivery_ms > entry.lastDeliveryAt.getTime()) {
        entry.lastDeliveryAt = new Date(row.last_delivery_ms);
      }
    }
    return result;
  }

  async #filterOptions(scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  }): Promise<{ subscribers: string[]; sources: string[] }> {
    const query = this.clickhouse.reader.query({
      name: "webhookEndpointsFilterOptions",
      query: `SELECT groupUniqArrayArray(subscriber_ids) AS subscribers, groupUniqArray(source) AS sources
        FROM trigger_dev.webhook_endpoints_v1 FINAL
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND _is_deleted = 0
          AND status != 'DELETING'`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
      }),
      schema: z.object({ subscribers: z.array(z.string()), sources: z.array(z.string()) }),
    });

    const [error, rows] = await query(scope);
    if (error) logger.warn("Webhook endpoint filter options query failed", { error });
    if (error || !rows[0]) return { subscribers: [], sources: [] };
    return { subscribers: rows[0].subscribers.sort(), sources: rows[0].sources.sort() };
  }
}
