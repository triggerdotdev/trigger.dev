import { useState } from "react";
import { useUserTimeZone } from "~/components/primitives/DateTime";
import { DetailChartBlock } from "~/components/primitives/DetailChartBlock";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { HealthViewToggle, type HealthView } from "./HealthViewToggle";
import { GroupsDropdown } from "./GroupsDropdown";
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
  assignGroupColors,
  thresholdChartLegend,
} from "./AlertThresholdChart";
import {
  hasTileData,
  isLimitComponent,
  isLimitsComposite,
  type LimitTileSeries,
} from "./limitTiles";
import { defaultGroupSelection, MAX_VISIBLE_GROUPS } from "./queryGroupSelection";

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
  limitTiles?: LimitTileSeries[];
  window: DetailWindow & { isLifetime?: boolean; explicitTo?: boolean };
  now: Date;
  createdAt?: Date;
  queryGroups?: string[];
  querySeriesMode?: "threshold" | "absence" | "match";
};

function limitsAsQueryProps(
  props: AlertDetailChartProps,
  tiles: LimitTileSeries[]
): AlertDetailChartProps {
  const { alert } = props;
  const single = tiles.length === 1 ? tiles[0] : undefined;
  return {
    ...props,
    alert: {
      ...alert,
      kind: "threshold",
      operator: ">",
      thresholdValue: tiles.find((t) => t.threshold !== null)?.threshold ?? undefined,
      unitSuffix: "%",
      scope: { type: "all" },
      currentReading: { status: "unavailable" },
      capabilityTitle: single?.label ?? alert.capabilityTitle,
    } as AlertDetail,
    metricSeriesMap: single
      ? new Map([["__agg__", single.points]])
      : new Map(tiles.map((t) => [t.label, t.points])),
    queryGroups: tiles.length > 1 ? tiles.map((t) => t.label) : [],
    querySeriesMode: "threshold",
  };
}

export function AlertDetailChart(rawProps: AlertDetailChartProps) {
  const [healthView, setHealthView] = useState<HealthView>("together");
  const [picked, setPicked] = useState<string[] | null>(null);
  const isLimits =
    rawProps.alert.kind === "state" &&
    (isLimitComponent(rawProps.alert.capabilityKey) ||
      isLimitsComposite(rawProps.alert.capabilityKey));
  const props = isLimits
    ? limitsAsQueryProps(
        rawProps,
        (rawProps.limitTiles ?? []).filter((t) => !t.failed && hasTileData(t.points))
      )
    : rawProps;
  const { alert, window, metricSeriesMap, queryGroups = [] } = props;
  const showToggle = alert.kind === "state" && (props.componentSeries?.length ?? 0) > 1;
  const groups = queryGroups;
  const groupSeries = metricSeriesMap;
  const grouped =
    alert.kind === "threshold" && props.querySeriesMode !== "match" && queryGroups.length > 0;
  const defaults = grouped
    ? defaultGroupSelection({
        groups,
        seriesMap: groupSeries,
        operator: alert.operator,
        range: { since: window.since.getTime(), until: window.until.getTime() },
      })
    : [];
  const showPicker = grouped && groups.length > 1;
  const selected = showPicker ? (picked ?? defaults) : defaults;
  // Colours carry over from the previous selection, so a toggle doesn't repaint other groups.
  const [colorState, setColorState] = useState({ key: "", colors: new Map<string, string>() });
  const selectedKey = JSON.stringify(selected);
  let groupColors = colorState.colors;
  if (colorState.key !== selectedKey) {
    groupColors = assignGroupColors(colorState.colors, selected);
    setColorState({ key: selectedKey, colors: groupColors });
  }
  const toggleGroup = (group: string) =>
    setPicked(
      selected.includes(group)
        ? selected.filter((g) => g !== group)
        : selected.length >= MAX_VISIBLE_GROUPS
          ? selected
          : [...selected, group]
    );

  const loadedTiles = rawProps.limitTiles ?? [];
  const limitsUnloaded =
    isLimits &&
    metricSeriesMap.size === 0 &&
    (loadedTiles.length === 0 || loadedTiles.some((t) => t.failed));

  return (
    <DetailChartBlock
      toolbar={<AlertDetailFilterBar lifetime={window.isLifetime ? window : undefined} />}
    >
      <div className="min-h-[210px] flex-1">
        {limitsUnloaded ? (
          <div className="flex h-full items-center justify-center text-xs text-text-dimmed">
            Couldn't load this data. Try again in a moment.
          </div>
        ) : (
          <AlertDetailChartBody
            {...props}
            healthView={healthView}
            selectedGroups={grouped ? selected : undefined}
            groupColors={groupColors}
            accessory={
              showToggle ? (
                <HealthViewToggle value={healthView} onChange={setHealthView} />
              ) : showPicker ? (
                <GroupsDropdown
                  groups={groups}
                  selected={selected}
                  onToggle={toggleGroup}
                  colors={groupColors}
                  noun={isLimits ? "limits" : undefined}
                />
              ) : undefined
            }
          />
        )}
      </div>
    </DetailChartBlock>
  );
}

function AlertDetailChartBody({
  alert,
  metricSeriesMap,
  healthBands,
  componentSeries = [],
  limitTiles = [],
  window,
  now,
  createdAt,
  healthView,
  selectedGroups,
  groupColors,
  querySeriesMode,
  accessory,
}: AlertDetailChartProps & {
  healthView: HealthView;
  selectedGroups?: string[];
  groupColors?: Map<string, string>;
  accessory?: React.ReactNode;
}) {
  const title = alertChartTitle(alert);
  const info = alertChartInfo(alert);
  const raisedAt = alert.episode.raisedAt;
  const timeZone = useUserTimeZone();

  if (querySeriesMode === "match") {
    const occurrences = (metricSeriesMap.get("__agg__") ?? []).map((p) => ({
      bucket: p.bucket,
      count: p.value ?? 0,
    }));
    return (
      <OccurrenceBarsCard
        alert={alert}
        occurrences={occurrences}
        window={window}
        createdAt={createdAt}
        timeZone={timeZone}
        accessory={accessory}
      />
    );
  }

  if (alert.kind === "threshold") {
    const raw = selectedGroups
      ? {
          multi: true as const,
          seriesMap: new Map(
            selectedGroups.flatMap((g) => {
              const points = metricSeriesMap.get(g);
              return points ? [[g, points] as const] : [];
            })
          ),
        }
      : pickThresholdSeries(metricSeriesMap, alert.scope.type);
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
    const soleGroup =
      pick.multi && pick.seriesMap.size === 1 ? [...pick.seriesMap.keys()][0] : undefined;
    const label = soleGroup ?? METRIC_LABEL[alert.capabilityKey] ?? alert.capabilityTitle;
    const chart = pick.multi ? (
      <AlertMultiSeriesChart
        seriesMap={pick.seriesMap}
        threshold={threshold}
        unit={alert.unitSuffix}
        label={label}
        operator={alert.operator}
        raisedAt={raisedAt}
        timeZone={timeZone}
        colors={groupColors}
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
          colors: groupColors,
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
              colors={groupColors}
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

  return (
    <OccurrenceBarsCard
      alert={alert}
      occurrences={(metricSeriesMap.get("__agg__") ?? []).map((p) => ({
        bucket: p.bucket,
        count: p.value ?? 0,
      }))}
      window={window}
      createdAt={createdAt}
      timeZone={timeZone}
      accessory={accessory}
    />
  );
}

function OccurrenceBarsCard({
  alert,
  occurrences,
  window,
  createdAt,
  timeZone,
  accessory,
}: {
  alert: AlertDetail;
  occurrences: { bucket: number; count: number }[];
  window: DetailWindow;
  createdAt?: Date;
  timeZone: string;
  accessory?: React.ReactNode;
}) {
  const raisedAt = alert.episode.raisedAt;
  const title = alertChartTitle(alert);
  const info = alertChartInfo(alert);
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
