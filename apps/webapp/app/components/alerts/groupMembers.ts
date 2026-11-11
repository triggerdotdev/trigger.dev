import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import type { HealthBandRow, HealthQuerySeries, MetricSeriesPoint } from "./alertSeriesTypes";
import { hasTileData, type LimitTileSeries } from "./limitTiles";

export function groupScopeSummary(names: string[]): string {
  return `Group · ${names.join(", ")}`;
}

export type AlertSeriesBundle = {
  metricSeriesEntries: [string, MetricSeriesPoint[]][];
  healthBands: HealthBandRow[];
  componentSeries: HealthQuerySeries[];
  limitTiles: LimitTileSeries[];
  queryGroups: string[];
  querySeriesMode: "threshold" | "absence" | "match" | undefined;
};

export type GroupMemberTile = AlertSeriesBundle & {
  id: string;
  name: string;
  alert: AlertDetail;
  createdAt: Date;
};

export function tileHasData(tile: GroupMemberTile): boolean {
  if (tile.alert.kind === "state") {
    return (
      tile.healthBands.some((b) => b.healthy || b.degraded) ||
      tile.componentSeries.some((s) => s.points.some((p) => typeof p.value === "number")) ||
      tile.limitTiles.some((t) => !t.failed && hasTileData(t.points))
    );
  }
  return tile.metricSeriesEntries.some(([, points]) =>
    points.some((p) => typeof p.value === "number")
  );
}
