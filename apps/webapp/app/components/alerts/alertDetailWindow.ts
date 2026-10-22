import parse from "parse-duration";
import { timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import {
  buildHealthBands,
  type HealthBandRow,
  type HealthQuerySeries,
  type MetricSeriesPoint,
} from "./alertSeriesTypes";

export { healthEventsForBands } from "./alertSeriesTypes";

export const DETAIL_DEFAULT_PERIOD = "7d";

export type DetailWindow = { since: Date; until: Date };

export function alertDetailWindow(
  params: { period?: string; from?: number; to?: number },
  lifetime: DetailWindow | undefined,
  createdAt?: Date
): DetailWindow & { isLifetime: boolean; explicitTo?: boolean } {
  const period = params.period && parse(params.period) ? params.period : undefined;
  const hasParam = period !== undefined || params.from !== undefined || params.to !== undefined;
  if (lifetime && !hasParam) return { ...lifetime, isLifetime: true };
  const { from, to } = timeFilterFromTo({
    ...params,
    period,
    defaultPeriod: DETAIL_DEFAULT_PERIOD,
  });
  const since =
    !period && params.from === undefined
      ? new Date(to.getTime() - parse(DETAIL_DEFAULT_PERIOD)!)
      : from;
  const fromCreation = !lifetime && createdAt && createdAt > since && createdAt < to;
  return {
    since: fromCreation ? createdAt : since,
    until: to,
    isLifetime: false,
    explicitTo: params.to !== undefined,
  };
}

export function detailHealthBands(
  bands: HealthBandRow[],
  window: DetailWindow,
  degraded: { now: boolean; since: Date | null; live: boolean }
): HealthBandRow[] {
  const base =
    bands.length > 0 ? bands : buildHealthBands([], window.until.getTime(), window.since.getTime());
  if (!degraded.now || base.length === 0) return base;
  const bucketMs =
    base.length > 1 ? base[1]!.bucket - base[0]!.bucket : window.until.getTime() - base[0]!.bucket;
  const from =
    degraded.since?.getTime() ?? (degraded.live ? base[base.length - 1]!.bucket : Infinity);
  return base.map((row) =>
    row.bucket + bucketMs > from ? { ...row, degraded: 1, healthy: null, unknown: null } : row
  );
}

export function firstDataAt(
  window: DetailWindow,
  createdAt: Date | undefined,
  sources: { series?: MetricSeriesPoint[][]; bands?: HealthBandRow[]; events?: { at: Date }[] }
): number {
  const candidates = [
    ...(sources.series ?? []).flatMap((points) => {
      const first = points.find((p) => p.value !== null);
      return first ? [first.bucket] : [];
    }),
    ...(sources.bands ?? []).filter((b) => b.healthy || b.degraded).map((b) => b.bucket),
    ...(sources.events ?? []).map((e) => e.at.getTime()),
  ];
  const first = candidates.length > 0 ? Math.min(...candidates) : window.since.getTime();
  return Math.max(first, createdAt?.getTime() ?? first);
}

export function sliceFrom<T extends { bucket: number }>(rows: T[], start: number): T[] {
  let i = rows.length - 1;
  while (i > 0 && rows[i]!.bucket > start) i--;
  return i > 0 ? rows.slice(i) : rows;
}

export function sliceHealthCard(
  sources: { bands: HealthBandRow[]; lines: HealthQuerySeries[]; events: { at: Date }[] },
  window: DetailWindow,
  createdAt?: Date
): { bands: HealthBandRow[]; lines: HealthQuerySeries[] } {
  const start = firstDataAt(window, createdAt, {
    bands: sources.bands,
    series: sources.lines.map((s) => s.points),
    events: sources.events,
  });
  return {
    bands: sliceFrom(sources.bands, start),
    lines: sources.lines.map((s) => ({ ...s, points: sliceFrom(s.points, start) })),
  };
}
