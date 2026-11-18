import {
  getAlertStateEvents,
  getLatestAlertEventTimes,
  listAlerts,
  type Alert,
  type AlertStateEvent,
} from "~/v3/services/alerts/storage/alertStore.server";
import {
  alertParamsSchema,
  displayStatus,
  getCapability,
  notifierRefKey,
  type Condition,
  type NotifierRef,
} from "@internal/alert-contracts";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { filterAlertRows, MAX_LIST_ALERTS } from "~/components/alerts/alertsListFilters";
import { CLEARING_EVENTS } from "~/components/alerts/alertSeriesTypes";
import { conditionSummary } from "~/components/alerts/alertSummaries";
import {
  alertChannelIssues,
  loadNotifierChannels,
  notifierChannelIds,
} from "~/v3/services/alerts/alertChannelIssues.server";
import { startActiveSpan } from "~/v3/tracer.server";
import {
  buildStateBuckets,
  compareAlertRows,
  episodeSummary,
  type AlertListRow,
  type AlertStateBucket,
} from "./alertListRow";

export type AlertsListFilters = Parameters<typeof filterAlertRows>[1];

const ALERTS_PAGE_SIZE = 50;
const LIST_SPARKLINE_BUCKETS = 24;
const LIST_EVENT_BUCKET_SECONDS = 7200;

function laterOf(a: Date | null, b: Date | null): Date | null {
  return a && b ? (b > a ? b : a) : (a ?? b);
}

function latestOf(...dates: (Date | null)[]): Date {
  return new Date(Math.max(...dates.map((d) => d?.getTime() ?? 0)));
}

function toRow(
  alert: Alert,
  lastRaisedAt: Date | null,
  lastRecoveredAt: Date | null,
  lastEventAt: Date | null
): AlertListRow {
  const capability = getCapability(alert.capabilityKey);
  const status = displayStatus(alert.lifecycle, alert.attention);
  const inactiveReason = status.status === "inactive" ? status.reason : undefined;
  const params = alertParamsSchema.safeParse(alert.params);

  return {
    id: alert.id,
    name: alert.name ?? capability?.title ?? alert.capabilityKey,
    area: capability?.area ?? "unknown",
    conditionSummary: conditionSummary(
      alert.condition as Condition,
      capability?.unit,
      capability?.title
    ),
    capabilityKey: alert.capabilityKey,
    capabilityTitle: capability?.title ?? alert.capabilityKey,
    environmentId: alert.environmentId,
    scope: params.success ? params.data.scope : undefined,
    status: status.status,
    groupId: alert.groupId,
    inactiveReason,
    lastEventAt: laterOf(lastEventAt, alert.lastOccurrenceAt),
    notifierCount: alert.notifiers.length,
    notifierKeys: (alert.notifiers as NotifierRef[]).map(notifierRefKey),
    episode: episodeSummary({
      status: status.status,
      inactiveReason,
      raisedAt: lastRaisedAt,
      recoveredAt: lastRecoveredAt,
      resolvedAt: alert.resolvedAt,
      stoppedAt: alert.stoppedAt,
      expiresAt: alert.expiresAt,
      observedCondition: alert.observedCondition,
    }),
    expiresAt: alert.expiresAt,
    lastActivityAt: latestOf(
      lastEventAt,
      alert.lastOccurrenceAt,
      alert.stoppedAt,
      alert.resolvedAt,
      alert.createdAt
    ),
  };
}

export type AlertsListPage = {
  rows: AlertListRow[];
  alerts: Alert[];
  page: number;
  totalPages: number;
  truncated: boolean;
};

export function listAlertRows(
  alertDb: PrismaClientOrTransaction,
  {
    environmentId,
    page = 1,
    filters,
  }: { environmentId: string; page?: number; filters?: AlertsListFilters }
): Promise<AlertsListPage> {
  return startActiveSpan("listAlertRows", async () => {
    const fetched = await listAlerts(alertDb, {
      environmentId,
      statuses: filters?.statuses,
      ungroupedOnly: true,
      limit: MAX_LIST_ALERTS + 1,
    });
    const truncated = fetched.length > MAX_LIST_ALERTS;
    const alerts = fetched.slice(0, MAX_LIST_ALERTS);
    const eventTimes = await getLatestAlertEventTimes(
      alertDb,
      alerts.map((a) => a.id)
    );

    const items = alerts
      .map((alert) => ({
        alert,
        row: toRow(
          alert,
          eventTimes.get(alert.id)?.raised ?? null,
          eventTimes.get(alert.id)?.recovered ?? null,
          eventTimes.get(alert.id)?.latest ?? null
        ),
      }))
      .sort((a, b) => compareAlertRows(a.row, b.row));
    const kept =
      filters &&
      new Set(
        filterAlertRows(
          items.map((i) => i.row),
          filters
        ).map((r) => r.id)
      );
    const sorted = kept ? items.filter((i) => kept.has(i.row.id)) : items;

    const totalPages = Math.max(1, Math.ceil(sorted.length / ALERTS_PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
    const visible = sorted.slice(
      (currentPage - 1) * ALERTS_PAGE_SIZE,
      currentPage * ALERTS_PAGE_SIZE
    );

    return {
      rows: visible.map((v) => v.row),
      alerts: visible.map((v) => v.alert),
      page: currentPage,
      totalPages,
      truncated,
    };
  });
}

export async function listChannelIssueAlertIds(
  prisma: PrismaClientOrTransaction,
  alerts: Alert[],
  environmentId: string
): Promise<string[]> {
  const channelIds = notifierChannelIds(alerts.flatMap((a) => a.notifiers as NotifierRef[]));
  if (channelIds.length === 0) return [];
  const { environmentType, channels } = await loadNotifierChannels(prisma, {
    projectId: alerts[0]!.projectId,
    environmentId,
    channelIds,
  });
  return alerts
    .filter(
      (alert) =>
        alertChannelIssues(alert.notifiers as NotifierRef[], channels, environmentType).length > 0
    )
    .map((alert) => alert.id);
}

export function stateBucketsSince(now: number): Date {
  const bucketMs = LIST_EVENT_BUCKET_SECONDS * 1000;
  return new Date(Math.floor(now / bucketMs) * bucketMs - (LIST_SPARKLINE_BUCKETS - 1) * bucketMs);
}

export function alertStateBuckets(
  alert: Alert,
  events: AlertStateEvent[],
  since: Date
): AlertStateBucket[] {
  return buildStateBuckets(
    events,
    since.getTime(),
    LIST_EVENT_BUCKET_SECONDS * 1000,
    LIST_SPARKLINE_BUCKETS,
    alert.lifecycle === "active" &&
      alert.attention === "needs_attention" &&
      alert.observedCondition === "met"
      ? alert.observedConditionChangedAt?.getTime()
      : undefined
  );
}

export async function listAlertStateBuckets(
  alertDb: PrismaClientOrTransaction,
  alerts: Alert[],
  now: number = Date.now()
): Promise<Record<string, AlertStateBucket[]>> {
  if (alerts.length === 0) return {};
  const since = stateBucketsSince(now);
  const events = await getAlertStateEvents(
    alertDb,
    alerts.map((a) => a.id),
    { since, bucketSeconds: LIST_EVENT_BUCKET_SECONDS, types: ["raised", ...CLEARING_EVENTS] }
  ).catch((error) => {
    console.warn("alerts.list.state_buckets_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map<string, AlertStateEvent[]>();
  });
  return Object.fromEntries(
    alerts.map((alert) => [alert.id, alertStateBuckets(alert, events.get(alert.id) ?? [], since)])
  );
}
