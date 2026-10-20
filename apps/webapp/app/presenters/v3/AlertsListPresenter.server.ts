import {
  getLatestAlertEventTimes,
  getAlertHealthEvents,
  listAlerts,
  type Alert,
  type AlertHealthEvent,
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
import { conditionSummary } from "~/components/alerts/alertSummaries";
import { prisma } from "~/db.server";
import {
  alertChannelIssues,
  loadNotifierChannels,
  notifierChannelIds,
} from "~/v3/services/alerts/alertChannelIssues.server";
import { BasePresenter } from "./basePresenter.server";
import {
  buildStateBuckets,
  compareAlertRows,
  episodeSummary,
  type AlertListRow,
  type AlertStateBucket,
} from "./alertListRow";

export type { AlertListRow } from "./alertListRow";

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
  lastEventAt: Date | null,
  hasChannelIssue: boolean
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
    hasChannelIssue,
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

export class AlertsListPresenter extends BasePresenter {
  constructor(
    private readonly _alertDb: PrismaClientOrTransaction = prisma,
    prismaClient: PrismaClientOrTransaction = prisma
  ) {
    super(prismaClient);
  }

  public async call({
    environmentId,
    page = 1,
    filters,
  }: {
    environmentId: string;
    page?: number;
    filters?: AlertsListFilters;
  }): Promise<{ rows: AlertListRow[]; page: number; totalPages: number; truncated: boolean }> {
    return this.trace("call", async () => {
      const fetched = await listAlerts(this._alertDb, {
        environmentId,
        statuses: filters?.statuses,
        limit: MAX_LIST_ALERTS + 1,
      });
      const truncated = fetched.length > MAX_LIST_ALERTS;
      const alerts = fetched.slice(0, MAX_LIST_ALERTS);
      const eventTimes = await getLatestAlertEventTimes(
        this._alertDb,
        alerts.map((a) => a.id)
      );
      const channelIssueIds = await this._channelIssueAlertIds(alerts, environmentId);

      const items = alerts
        .map((alert) => ({
          alert,
          row: toRow(
            alert,
            eventTimes.get(alert.id)?.raised ?? null,
            eventTimes.get(alert.id)?.recovered ?? null,
            eventTimes.get(alert.id)?.latest ?? null,
            channelIssueIds.has(alert.id)
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

      const stateBuckets = await this._resolveStateBuckets(visible.map((v) => v.alert));

      return {
        rows: visible.map(({ alert, row }) => ({
          ...row,
          stateBuckets: stateBuckets.get(alert.id),
        })),
        page: currentPage,
        totalPages,
        truncated,
      };
    });
  }

  private async _channelIssueAlertIds(alerts: Alert[], environmentId: string) {
    const ids = new Set<string>();
    const channelIds = notifierChannelIds(alerts.flatMap((a) => a.notifiers as NotifierRef[]));
    if (channelIds.length === 0) return ids;
    const { environmentType, channels } = await loadNotifierChannels(this._prisma, {
      projectId: alerts[0]!.projectId,
      environmentId,
      channelIds,
    });
    for (const alert of alerts) {
      if (alertChannelIssues(alert.notifiers as NotifierRef[], channels, environmentType).length) {
        ids.add(alert.id);
      }
    }
    return ids;
  }

  private async _resolveStateBuckets(alerts: Alert[]): Promise<Map<string, AlertStateBucket[]>> {
    const bucketMs = LIST_EVENT_BUCKET_SECONDS * 1000;
    const alignedNowMs = Math.floor(Date.now() / bucketMs) * bucketMs;
    const since = new Date(alignedNowMs - (LIST_SPARKLINE_BUCKETS - 1) * bucketMs);
    const result = new Map<string, AlertStateBucket[]>();
    if (alerts.length === 0) return result;
    const events = await getAlertHealthEvents(
      this._alertDb,
      alerts.map((a) => a.id),
      since
    ).catch((error) => {
      console.warn("alerts.list.state_buckets_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map<string, AlertHealthEvent[]>();
    });
    for (const alert of alerts) {
      result.set(
        alert.id,
        buildStateBuckets(
          events.get(alert.id) ?? [],
          since.getTime(),
          bucketMs,
          LIST_SPARKLINE_BUCKETS,
          alert.lifecycle === "active" &&
            alert.attention === "needs_attention" &&
            alert.observedCondition === "met"
            ? alert.observedConditionChangedAt?.getTime()
            : undefined
        )
      );
    }
    return result;
  }
}
