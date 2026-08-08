import { type ClickhouseQueryBuilder } from "@internal/clickhouse";
import { boundedIn } from "@trigger.dev/database";
import { decodeRunsCursor, encodeRunsCursor } from "../runsRepository/runsCursor.server";
import {
  type CountDeliveriesByEndpointOptions,
  type DetailedWebhookDelivery,
  type FilterWebhookDeliveriesOptions,
  type GetDeliveriesByFriendlyIdsOptions,
  type GetWebhookDeliveryOptions,
  type IWebhookDeliveriesRepository,
  type ListedWebhookDelivery,
  type ListWebhookDeliveriesOptions,
  type WebhookDeliveriesRepositoryOptions,
  type WebhookDeliveryIdsPage,
} from "./webhookDeliveriesRepository.server";

type DeliveryCursorRow = { deliveryId: string; createdAt: number };

const WEBHOOK_DELIVERY_ID_PREFIX = "whd_";

const DELIVERY_DETAIL_SELECT = {
  id: true,
  friendlyId: true,
  webhookEndpointId: true,
  runtimeEnvironmentId: true,
  environmentType: true,
  status: true,
  externalDeliveryId: true,
  idempotencyKey: true,
  runId: true,
  rawBodyHash: true,
  parsedEvent: true,
  headers: true,
  errorMessage: true,
  filterReason: true,
  createdAt: true,
  updatedAt: true,
  processedAt: true,
} as const;

const DELIVERY_LIST_SELECT = {
  id: true,
  friendlyId: true,
  webhookEndpointId: true,
  runtimeEnvironmentId: true,
  status: true,
  isTest: true,
  externalDeliveryId: true,
  runId: true,
  createdAt: true,
  processedAt: true,
  errorMessage: true,
} as const;

export class ClickHouseWebhookDeliveriesRepository implements IWebhookDeliveriesRepository {
  constructor(private readonly options: WebhookDeliveriesRepositoryOptions) {}

  get name() {
    return "clickhouse";
  }

  /**
   * Runs the keyset-paginated query and returns `{ deliveryId, createdAt }` rows
   * (one extra beyond `page.size` to signal "has more"). The ordering is always
   * the composite `(created_at, delivery_id)`; the cursor predicate must match
   * it. The cursor is the shared opaque `runsCursor` token — its `runId` field
   * carries the delivery id here.
   */
  private async listDeliveryRows(
    options: ListWebhookDeliveriesOptions
  ): Promise<DeliveryCursorRow[]> {
    const queryBuilder = this.options.clickhouse.webhookDeliveries.queryBuilder();
    applyDeliveryFiltersToQueryBuilder(queryBuilder, options);

    const forward = options.page.direction === "forward" || !options.page.direction;

    if (options.page.cursor) {
      const decoded = decodeRunsCursor(options.page.cursor);

      if (forward) {
        if (decoded.kind === "composite") {
          queryBuilder.where(
            "(created_at, delivery_id) < (fromUnixTimestamp64Milli({cursorCreatedAt: Int64}), {deliveryId: String})",
            { cursorCreatedAt: decoded.createdAt, deliveryId: decoded.runId }
          );
        } else {
          queryBuilder.where("delivery_id < {deliveryId: String}", { deliveryId: decoded.runId });
        }
        queryBuilder.orderBy("created_at DESC, delivery_id DESC");
      } else {
        if (decoded.kind === "composite") {
          queryBuilder.where(
            "(created_at, delivery_id) > (fromUnixTimestamp64Milli({cursorCreatedAt: Int64}), {deliveryId: String})",
            { cursorCreatedAt: decoded.createdAt, deliveryId: decoded.runId }
          );
        } else {
          queryBuilder.where("delivery_id > {deliveryId: String}", { deliveryId: decoded.runId });
        }
        queryBuilder.orderBy("created_at ASC, delivery_id ASC");
      }

      queryBuilder.limit(options.page.size + 1);
    } else {
      // Initial page - no cursor provided
      queryBuilder.orderBy("created_at DESC, delivery_id DESC").limit(options.page.size + 1);
    }

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    return result.map((row) => ({ deliveryId: row.delivery_id, createdAt: row.created_at_ms }));
  }

  /**
   * Turns the (size + 1) result rows into the actual page of rows plus the
   * forward/backward cursors. Mirrors ClickHouseRunsRepository.listRunIds; the
   * cursor tokens are composite so pagination can't duplicate or skip
   * deliveries. Shared by listDeliveryIds and listDeliveries so the hydration
   * path can reuse the page rows (and their created_at values) directly.
   */
  private buildPage(
    rows: DeliveryCursorRow[],
    options: ListWebhookDeliveriesOptions
  ): {
    pageRows: DeliveryCursorRow[];
    pagination: { nextCursor: string | null; previousCursor: string | null };
  } {
    // listDeliveryRows fetches one extra row beyond page.size to detect "has more".
    const hasMore = rows.length > options.page.size;

    const cursorFor = (row: DeliveryCursorRow | undefined): string | null =>
      row ? encodeRunsCursor(row.createdAt, row.deliveryId) : null;

    let nextCursor: string | null = null;
    let previousCursor: string | null = null;

    const direction = options.page.direction ?? "forward";
    switch (direction) {
      case "forward": {
        previousCursor = options.page.cursor ? cursorFor(rows.at(0)) : null;
        if (hasMore) {
          // The next cursor is the last delivery on this page.
          nextCursor = cursorFor(rows[options.page.size - 1]);
        }
        break;
      }
      case "backward": {
        const reversedRows = [...rows].reverse();
        if (hasMore) {
          previousCursor = cursorFor(reversedRows.at(1));
          nextCursor = cursorFor(reversedRows.at(options.page.size));
        } else {
          // No newer rows, so there's no previous (newer) page. The next
          // (older) cursor is the oldest row on this page = rows[0] (rows are
          // ASC here). Index by the actual row count, not page.size — on a
          // partial page (fewer than page.size rows) page.size-1 overshoots
          // and would null the cursor, stranding forward navigation.
          nextCursor = cursorFor(rows.at(0));
        }
        break;
      }
    }

    // The page is always the first `page.size` rows of the result. listDeliveryRows
    // fetches one extra row only to detect `hasMore`; that extra row is the
    // farthest from the cursor in BOTH directions (forward orders DESC, backward
    // orders ASC), so it's always the trailing element to drop — never the
    // leading one.
    const pageRows = rows.slice(0, options.page.size);

    return { pageRows, pagination: { nextCursor, previousCursor } };
  }

  async listDeliveryIds(options: ListWebhookDeliveriesOptions): Promise<WebhookDeliveryIdsPage> {
    const rows = await this.listDeliveryRows(options);
    const { pageRows, pagination } = this.buildPage(rows, options);

    return { deliveryIds: pageRows.map((row) => row.deliveryId), pagination };
  }

  async listDeliveries(options: ListWebhookDeliveriesOptions) {
    const rows = await this.listDeliveryRows(options);
    const { pageRows, pagination } = this.buildPage(rows, options);

    if (pageRows.length === 0) {
      return { deliveries: [], pagination };
    }

    const deliveryIds = pageRows.map((row) => row.deliveryId);

    // PARTITION PRUNING: webhookDelivery is RANGE-partitioned on createdAt. An
    // `id IN (...)` query without a createdAt predicate scans every child
    // partition, so derive a [min, max] range from the CH page and pass it
    // through. This is the one place webhook hydration diverges from runs.
    const createdAtMsValues = pageRows.map((row) => row.createdAt);
    const minCreatedAtMs = Math.min(...createdAtMsValues);
    const maxCreatedAtMs = Math.max(...createdAtMsValues);

    // CH gives the ordered id list; Postgres hydrates the full lean rows by PK id.
    const deliveries = await this.options.prisma.webhookDelivery.findMany({
      where: {
        id: { in: boundedIn(deliveryIds) },
        createdAt: {
          gte: new Date(minCreatedAtMs),
          lte: new Date(maxCreatedAtMs),
        },
      },
      select: DELIVERY_LIST_SELECT,
    });

    // Re-order to CH order (findMany does not preserve `in` order).
    const byId = new Map(deliveries.map((d) => [d.id, d]));
    let result = deliveryIds
      .map((id) => byId.get(id))
      .filter((d): d is (typeof deliveries)[number] => Boolean(d));

    // ClickHouse is slightly delayed, so re-filter status in memory too.
    if (options.statuses && options.statuses.length > 0) {
      result = result.filter((d) => options.statuses!.includes(d.status));
    }

    return { deliveries: result, pagination };
  }

  async countDeliveries(options: FilterWebhookDeliveriesOptions) {
    const queryBuilder = this.options.clickhouse.webhookDeliveries.countQueryBuilder();
    applyDeliveryFiltersToQueryBuilder(queryBuilder, options);

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    if (result.length === 0) {
      throw new Error("No count rows returned");
    }

    return result[0].count;
  }

  async countDeliveriesByEndpoint(
    options: CountDeliveriesByEndpointOptions
  ): Promise<Map<string, number>> {
    if (options.webhookEndpointIds.length === 0) {
      return new Map();
    }

    const queryBuilder = this.options.clickhouse.webhookDeliveries.groupedCountQueryBuilder();
    queryBuilder
      .where("organization_id = {organizationId: String}", {
        organizationId: options.organizationId,
      })
      .where("project_id = {projectId: String}", { projectId: options.projectId })
      .where("environment_id = {environmentId: String}", { environmentId: options.environmentId })
      .where("webhook_endpoint_id IN {webhookEndpointIds: Array(String)}", {
        webhookEndpointIds: options.webhookEndpointIds,
      })
      .where("created_at >= fromUnixTimestamp64Milli({period: Int64})", {
        period: Date.now() - options.period,
      })
      .groupBy("webhook_endpoint_id");

    const [queryError, rows] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.webhook_endpoint_id, row.count);
    }
    return counts;
  }

  /**
   * A point lookup: pure Postgres, never ClickHouse. `friendlyId` is `whd_` + the row id, so we
   * strip the prefix and hit the composite-PK index (scoped by environment). ClickHouse is for
   * aggregations and for filtering/ordering a list into ids, never for selecting a row's columns.
   */
  async getDelivery(options: GetWebhookDeliveryOptions): Promise<DetailedWebhookDelivery | null> {
    const id = options.friendlyId.startsWith(WEBHOOK_DELIVERY_ID_PREFIX)
      ? options.friendlyId.slice(WEBHOOK_DELIVERY_ID_PREFIX.length)
      : options.friendlyId;

    return this.options.prisma.webhookDelivery.findFirst({
      where: { id, runtimeEnvironmentId: options.environmentId },
      select: DELIVERY_DETAIL_SELECT,
    });
  }

  /**
   * Hydrate a known set of deliveries by friendlyId. Pure Postgres: the caller (the live poll)
   * already has the ids, so there is nothing for ClickHouse to filter or order.
   */
  async getDeliveriesByFriendlyIds(
    options: GetDeliveriesByFriendlyIdsOptions
  ): Promise<ListedWebhookDelivery[]> {
    const ids = options.friendlyIds.map((friendlyId) =>
      friendlyId.startsWith(WEBHOOK_DELIVERY_ID_PREFIX)
        ? friendlyId.slice(WEBHOOK_DELIVERY_ID_PREFIX.length)
        : friendlyId
    );
    if (ids.length === 0) return [];

    return this.options.prisma.webhookDelivery.findMany({
      where: { id: { in: boundedIn(ids) }, runtimeEnvironmentId: options.environmentId },
      select: DELIVERY_LIST_SELECT,
    });
  }
}

function applyDeliveryFiltersToQueryBuilder<T>(
  queryBuilder: ClickhouseQueryBuilder<T>,
  options: FilterWebhookDeliveriesOptions
) {
  queryBuilder
    .where("organization_id = {organizationId: String}", {
      organizationId: options.organizationId,
    })
    .where("project_id = {projectId: String}", { projectId: options.projectId })
    .where("environment_id = {environmentId: String}", { environmentId: options.environmentId });

  if (options.webhookEndpointId) {
    queryBuilder.where("webhook_endpoint_id = {webhookEndpointId: String}", {
      webhookEndpointId: options.webhookEndpointId,
    });
  }

  if (options.webhookEndpointIds && options.webhookEndpointIds.length > 0) {
    queryBuilder.where("webhook_endpoint_id IN {webhookEndpointIds: Array(String)}", {
      webhookEndpointIds: options.webhookEndpointIds,
    });
  }

  if (options.deliveryId) {
    queryBuilder.where(
      "(friendly_id = {deliveryId: String} OR external_delivery_id = {deliveryId: String})",
      { deliveryId: options.deliveryId }
    );
  }

  if (options.runId) {
    queryBuilder.where("run_id = {runId: String}", { runId: options.runId });
  }

  if (options.statuses && options.statuses.length > 0) {
    queryBuilder.where("status IN {statuses: Array(String)}", { statuses: options.statuses });
  }

  if (options.isTest !== undefined) {
    queryBuilder.where("is_test = {isTest: UInt8}", { isTest: options.isTest ? 1 : 0 });
  }

  // PARTITION PRUNING: the list MUST carry a created_at range.
  if (options.period) {
    queryBuilder.where("created_at >= fromUnixTimestamp64Milli({period: Int64})", {
      period: new Date(Date.now() - options.period).getTime(),
    });
  }
  if (options.from) {
    queryBuilder.where("created_at >= fromUnixTimestamp64Milli({from: Int64})", {
      from: options.from,
    });
  }
  if (options.to) {
    queryBuilder.where("created_at <= fromUnixTimestamp64Milli({to: Int64})", { to: options.to });
  }
}
