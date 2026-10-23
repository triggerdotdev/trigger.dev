import { useState } from "react";
import { useUserTimeZone } from "~/components/primitives/DateTime";
import { DetailChartBlock } from "~/components/primitives/DetailChartBlock";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { HealthViewToggle, type HealthView } from "./HealthViewToggle";
import { PreviewChartCard } from "./PreviewChartCard";
import { alertChartInfo } from "./alertSummaries";
import { ActivityBars, EVENT_CHART_COLOR } from "./ActivityBars";
import {
  AbsenceActivityChart,
  absenceLegend,
  HEALTH_LEGEND,
  HealthActivityChart,
  healthAxis,
} from "./AlertDetailCharts";
import { absenceSilenceStart } from "./alertDetailEpisode";
import {
  DETAIL_DEFAULT_PERIOD,
  detailHealthBands,
  firstDataAt,
  sliceFrom,
  sliceHealthCard,
  type DetailWindow,
} from "./alertDetailWindow";
import {
  AlertHealthQueriesChart,
  drawnHealthSeries,
  healthQueriesLegend,
} from "./AlertHealthQueriesChart";
import {
  HEALTH_BUCKET_MS,
  pickThresholdSeries,
  type HealthBandRow,
  type HealthQuerySeries,
  type MetricSeriesPoint,
} from "./alertSeriesTypes";
import {
  AlertMultiSeriesChart,
  AlertThresholdChart,
  thresholdChartLegend,
} from "./AlertThresholdChart";

const METRIC_LABEL: Record<string, string> = {
  "queue.depth": "Depth",
  "queue.oldest_age": "Oldest",
  "queue.concurrency": "Concurrency",
  "queue.scheduling_delay_p95": "Scheduling delay p95",
  "runs.volume": "Runs",
  "runs.duration_p95": "Duration p95",
  "runs.failure_rate": "Failure rate",
  "runs.failed": "Failed runs",
  "errors.new": "New error groups",
  "errors.occurred_again": "Occurrences",
};

const FLUSH_CARD = "rounded-none border-0 bg-transparent";

const OCCURRENCE_SERIES = [{ key: "count", label: "Occurrences", color: EVENT_CHART_COLOR }];

function healthLegend(
  separate: boolean,
  componentSeries: Parameters<typeof healthQueriesLegend>[0]
) {
  return separate ? healthQueriesLegend(componentSeries) : HEALTH_LEGEND;
}

export function AlertDetailFilterBar({ lifetime }: { lifetime?: DetailWindow }) {
  return (
    <TimeFilter
      defaultPeriod={DETAIL_DEFAULT_PERIOD}
      labelName="Occurred"
      from={lifetime ? String(lifetime.since.getTime()) : undefined}
      to={lifetime ? String(lifetime.until.getTime()) : undefined}
    />
  );
}

function alertChartTitle(alert: Pick<AlertDetail, "kind" | "capabilityTitle">): string {
  if (alert.kind === "state") return "Environment status";
  if (alert.kind === "absence") return "Time since last run";
  return alert.capabilityTitle;
}

type AlertDetailChartProps = {
  alert: AlertDetail;
  metricSeriesMap: Map<string, MetricSeriesPoint[]>;
  healthBands: HealthBandRow[];
  componentSeries?: HealthQuerySeries[];
  window: DetailWindow & { isLifetime?: boolean; explicitTo?: boolean };
  now: Date;
  createdAt?: Date;
};

export function AlertDetailChart(props: AlertDetailChartProps) {
  const [healthView, setHealthView] = useState<HealthView>("together");
  const { alert, window } = props;
  const showToggle = alert.kind === "state" && (props.componentSeries?.length ?? 0) > 1;

  return (
    <DetailChartBlock
      toolbar={<AlertDetailFilterBar lifetime={window.isLifetime ? window : undefined} />}
    >
      <div className="min-h-[210px] flex-1">
        <AlertDetailChartBody
          {...props}
          healthView={healthView}
          accessory={
            showToggle ? (
              <HealthViewToggle value={healthView} onChange={setHealthView} />
            ) : undefined
          }
        />
      </div>
    </DetailChartBlock>
  );
}

function AlertDetailChartBody({
  alert,
  metricSeriesMap,
  healthBands,
  componentSeries = [],
  window,
  now,
  createdAt,
  healthView,
  accessory,
}: AlertDetailChartProps & { healthView: HealthView; accessory?: React.ReactNode }) {
  const title = alertChartTitle(alert);
  const info = alertChartInfo(alert);
  const raisedAt = alert.episode.raisedAt;
  const timeZone = useUserTimeZone();

  if (alert.kind === "threshold") {
    const raw = pickThresholdSeries(metricSeriesMap, alert.scope.type);
    const start = firstDataAt(window, createdAt, {
      series: raw.multi ? [...raw.seriesMap.values()] : [raw.series],
      events: alert.events,
    });
    const pick = raw.multi
      ? {
          ...raw,
          seriesMap: new Map(
            [...raw.seriesMap].map(([key, points]) => [key, sliceFrom(points, start)])
          ),
        }
      : { ...raw, series: sliceFrom(raw.series, start) };
    const facts =
      alert.currentReading.status === "available" && alert.currentReading.result.kind === "stateful"
        ? alert.currentReading.result.facts
        : undefined;
    const threshold =
      typeof facts?.threshold === "number" ? facts.threshold : (alert.thresholdValue ?? null);
    const label = METRIC_LABEL[alert.capabilityKey] ?? alert.capabilityTitle;
    const chart = pick.multi ? (
      <AlertMultiSeriesChart
        seriesMap={pick.seriesMap}
        threshold={threshold}
        unit={alert.unitSuffix}
        label={label}
        operator={alert.operator}
        raisedAt={raisedAt}
        timeZone={timeZone}
        fill
      />
    ) : (
      <AlertThresholdChart
        series={pick.series}
        threshold={threshold}
        unit={alert.unitSuffix}
        label={label}
        operator={alert.operator}
        raisedAt={raisedAt}
        timeZone={timeZone}
        fill
      />
    );
    return (
      <PreviewChartCard
        className={FLUSH_CARD}
        title={title}
        info={info}
        legend={thresholdChartLegend({
          seriesMap: pick.multi ? pick.seriesMap : undefined,
          label,
          threshold,
          operator: alert.operator,
        })}
        alwaysShowControls
        accessory={accessory}
        fullscreenChildren={
          pick.multi ? (
            <AlertMultiSeriesChart
              seriesMap={pick.seriesMap}
              threshold={threshold}
              unit={alert.unitSuffix}
              label={label}
              operator={alert.operator}
              raisedAt={raisedAt}
              timeZone={timeZone}
              fill
              showLegend
            />
          ) : (
            chart
          )
        }
      >
        {chart}
      </PreviewChartCard>
    );
  }

  if (alert.kind === "state") {
    const inactive = alert.status.status === "inactive";
    const bucketMs =
      healthBands.length > 1 ? healthBands[1]!.bucket - healthBands[0]!.bucket : HEALTH_BUCKET_MS;
    const live = !window.explicitTo && window.until.getTime() >= now.getTime() - bucketMs;
    const degradedNow = live && alert.episode.outcome === "raised" && !inactive;
    const allBands = detailHealthBands(healthBands, window, {
      now: degradedNow,
      since: raisedAt,
      live,
    });
    const { bands, lines } = sliceHealthCard(
      { bands: allBands, lines: componentSeries, events: alert.events },
      window,
      createdAt
    );
    const drawn = drawnHealthSeries(lines);
    const current = degradedNow ? 0 : live && !inactive && alert.evaluated ? 1 : undefined;
    const separate =
      componentSeries.length === 1 || (healthView === "separate" && componentSeries.length > 1);
    const together = healthAxis(bands, raisedAt, current, timeZone);
    const ends = together.data;
    const chart = separate ? (
      <AlertHealthQueriesChart
        series={drawn}
        domain={ends.length > 0 ? [ends[0]!.bucket, ends[ends.length - 1]!.bucket] : undefined}
        axis={together}
        timeZone={timeZone}
      />
    ) : (
      <HealthActivityChart
        bands={bands}
        raisedAt={raisedAt}
        current={current}
        timeZone={timeZone}
      />
    );
    return (
      <PreviewChartCard
        className={FLUSH_CARD}
        title={title}
        info={info}
        legend={healthLegend(separate, drawn)}
        alwaysShowControls
        accessory={accessory}
        fullscreenChildren={chart}
      >
        {chart}
      </PreviewChartCard>
    );
  }

  if (alert.kind === "absence") {
    const allRuns = metricSeriesMap.get("__agg__") ?? [];
    const metricAgg = sliceFrom(
      allRuns,
      firstDataAt(window, createdAt, { series: [allRuns], events: alert.events })
    );
    const silentSince = absenceSilenceStart(alert);
    const trailing = silentSince && !window.explicitTo ? { since: silentSince, now } : undefined;
    const chart = (
      <AbsenceActivityChart
        series={metricAgg}
        quietWindowSec={alert.windowSec}
        trailing={trailing}
        raisedAt={raisedAt}
        timeZone={timeZone}
      />
    );
    return (
      <PreviewChartCard
        className={FLUSH_CARD}
        title={title}
        info={info}
        legend={absenceLegend(metricAgg, alert.windowSec, trailing)}
        alwaysShowControls
        accessory={accessory}
        fullscreenChildren={chart}
      >
        {chart}
      </PreviewChartCard>
    );
  }

  const occurrences = (metricSeriesMap.get("__agg__") ?? []).map((p) => ({
    bucket: p.bucket,
    count: p.value ?? 0,
  }));
  const start = firstDataAt(window, createdAt, {
    series: [occurrences.map((p) => ({ bucket: p.bucket, value: p.count }))],
    events: alert.events,
  });
  const chart = (
    <ActivityBars
      data={sliceFrom(occurrences, start)}
      series={OCCURRENCE_SERIES}
      yAxis="count"
      raisedAt={raisedAt}
      timeZone={timeZone}
    />
  );
  return (
    <PreviewChartCard
      className={FLUSH_CARD}
      title={title}
      info={info}
      legend={[{ swatch: "area", color: EVENT_CHART_COLOR, label: "Occurrences" }]}
      alwaysShowControls
      accessory={accessory}
      fullscreenChildren={chart}
    >
      {chart}
    </PreviewChartCard>
  );
}
