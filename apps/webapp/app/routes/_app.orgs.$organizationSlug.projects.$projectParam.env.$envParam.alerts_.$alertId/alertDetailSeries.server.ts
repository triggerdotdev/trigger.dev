import {
  alertParamsSchema,
  conditionSchema,
  getCapability,
  GROUP_CAPABILITY_KEY,
  type Condition,
} from "@internal/alert-contracts";
import pLimit from "p-limit";
import type { PrismaClient } from "@trigger.dev/database";
import {
  alertDetailWindow,
  healthEventsForBands,
  type DetailWindow,
} from "~/components/alerts/alertDetailWindow";
import { buildHealthBands } from "~/components/alerts/alertSeriesTypes";
import { type AlertSeriesBundle, type GroupMemberTile } from "~/components/alerts/groupMembers";
import { env } from "~/env.server";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { logger } from "~/services/logger.server";
import type { QueryConcurrencyLane } from "~/services/queryService.server";
import {
  alertLifetimeWindow,
  getMetricSeries,
  planHealthChartEvents,
} from "~/v3/services/alerts/alertSeries.server";
import { createQueryRowRunner } from "~/v3/services/alerts/engine/productionEvaluateBinding.server";
import {
  getHealthQuerySeries,
  getLimitTileSeries,
} from "~/v3/services/alerts/healthQuerySeries.server";
import { getQueryAlertSeries } from "~/v3/services/alerts/queryAlerts/queryAlertSeries.server";
import {
  CUSTOM_QUERY_CAPABILITY,
  resolveAlertCapability,
} from "~/v3/services/alerts/queryAlerts/resolveAlertCapability.server";
import {
  ALERT_EVENT_WINDOW_CAP,
  getAlert,
  latestAlertEventBefore,
  listAlertEventsInWindow,
  type Alert,
} from "~/v3/services/alerts/storage/alertStore.server";
import { healthBucketMs } from "./healthBucketMs.server";

export const EMPTY_SERIES: AlertSeriesBundle = {
  metricSeriesEntries: [],
  healthBands: [],
  componentSeries: [],
  limitTiles: [],
  queryGroups: [],
  querySeriesMode: undefined,
};

type SeriesProject = { id: string; organizationId: string };

export function resolveAlertDetailWindow(input: {
  rawAlert: Alert | null;
  params: { period?: string; from?: number; to?: number };
  maxWindowDays: number;
}) {
  const { rawAlert } = input;
  const clampsToCreation = (rawAlert?.condition as { kind?: string } | undefined)?.kind !== "state";
  return alertDetailWindow(
    input.params,
    rawAlert ? alertLifetimeWindow(rawAlert) : undefined,
    clampsToCreation ? rawAlert?.createdAt : undefined,
    input.maxWindowDays
  );
}

export async function loadAlertSeries(
  prisma: PrismaClient,
  input: {
    alertId: string;
    kind: Condition["kind"];
    rawAlert: Alert;
    window: DetailWindow;
    project: SeriesProject;
    lane?: QueryConcurrencyLane;
  }
): Promise<AlertSeriesBundle> {
  const { alertId, kind, rawAlert, window: detailWindow, project, lane } = input;
  const series: AlertSeriesBundle = { ...EMPTY_SERIES };
  const capability = getCapability(rawAlert.capabilityKey);

  if (kind === "state") {
    const queryCapability =
      capability?.binding.type === "query" && rawAlert.capabilityKey !== GROUP_CAPABILITY_KEY
        ? capability
        : undefined;
    const seriesInput = queryCapability && {
      alertId,
      capability: queryCapability,
      params: rawAlert.params,
      condition: rawAlert.condition,
      organizationId: project.organizationId,
      projectId: project.id,
      window: detailWindow,
    };
    const [events, seedEvent, queryLines, tiles] = await Promise.all([
      listAlertEventsInWindow(prisma, alertId, {
        since: detailWindow.since,
        until: detailWindow.until,
        limit: ALERT_EVENT_WINDOW_CAP + 1,
      }),
      latestAlertEventBefore(prisma, alertId, detailWindow.since),
      seriesInput
        ? getHealthQuerySeries(
            seriesInput,
            createQueryRowRunner(undefined, { lane: "alerts" })
          ).catch(() => undefined)
        : undefined,
      seriesInput
        ? getLimitTileSeries(
            seriesInput,
            createQueryRowRunner(undefined, { lane: "alerts" })
          ).catch(() => [])
        : [],
    ]);
    series.componentSeries = queryLines?.series ?? [];
    series.limitTiles = tiles;
    const chart = planHealthChartEvents({
      seed: seedEvent,
      events,
      healthySince:
        rawAlert.lifecycle === "active" && rawAlert.lastEvaluatedAt != null
          ? rawAlert.createdAt.getTime()
          : undefined,
      cap: ALERT_EVENT_WINDOW_CAP,
    });
    series.healthBands = buildHealthBands(
      healthEventsForBands(chart.events),
      detailWindow.until.getTime(),
      detailWindow.since.getTime(),
      healthBucketMs(detailWindow, capability?.minCadenceSec ?? 300),
      chart.healthySince
    );
  } else if (rawAlert.capabilityKey === CUSTOM_QUERY_CAPABILITY) {
    const params = alertParamsSchema.parse(rawAlert.params);
    const seriesMap = await getQueryAlertSeries(
      {
        alert: {
          id: rawAlert.id,
          organizationId: project.organizationId,
          projectId: project.id,
          params,
        },
        capability: resolveAlertCapability(rawAlert),
        condition: conditionSchema.parse(rawAlert.condition),
        window: detailWindow,
      },
      createQueryRowRunner(undefined, { userAuthoredQuery: true, lane })
    );
    series.metricSeriesEntries = Array.from(seriesMap.entries());
    series.queryGroups = params.querySignal?.groupColumns?.length
      ? series.metricSeriesEntries.map(([key]) => key)
      : [];
    series.querySeriesMode = params.querySignal?.mode;
  } else if (capability?.binding.type === "query") {
    const params = alertParamsSchema.parse(rawAlert.params);
    const metricMap = await getMetricSeries(
      {
        alertId,
        capability,
        params,
        condition: conditionSchema.parse(rawAlert.condition),
        organizationId: project.organizationId,
        projectId: project.id,
        window: detailWindow,
        failureRateMinVolume: env.ALERT_FAILURE_RATE_MIN_VOLUME,
      },
      createQueryRowRunner(undefined, { lane })
    );
    series.metricSeriesEntries = Array.from(metricMap.entries());
  }
  return series;
}

export async function loadGroupMemberTiles(
  prisma: PrismaClient,
  input: {
    memberIds: string[];
    concurrency: number;
    window: DetailWindow;
    project: SeriesProject;
    environmentId: string;
  },
  deps: {
    getDetail: (id: string) => Promise<AlertDetail | null>;
    loadSeries?: typeof loadAlertSeries;
  }
): Promise<GroupMemberTile[]> {
  const loadSeries = deps.loadSeries ?? loadAlertSeries;
  const limit = pLimit(input.concurrency);
  const tiles = await Promise.all(
    input.memberIds.map((id) =>
      limit(async (): Promise<GroupMemberTile | null> => {
        const raw = await getAlert(prisma, {
          id,
          projectId: input.project.id,
          environmentId: input.environmentId,
        });
        const alert =
          raw &&
          (await deps.getDetail(id).catch((error) => {
            logger.error("Failed to load group member detail", { alertId: id, error });
            return null;
          }));
        if (!raw || !alert) return null;
        const series = await loadSeries(prisma, {
          alertId: id,
          kind: alert.kind,
          rawAlert: raw,
          window: input.window,
          project: input.project,
          lane: "alerts",
        }).catch((error) => {
          logger.error("Failed to load group member chart series", { alertId: id, error });
          return EMPTY_SERIES;
        });
        return { ...series, id, name: alert.name, alert, createdAt: raw.createdAt };
      })
    )
  );
  return tiles.filter((tile): tile is GroupMemberTile => tile !== null);
}
