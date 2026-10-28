import { getCapability } from "@internal/alert-contracts";
import type { MetricSeriesPoint } from "./alertSeriesTypes";

export type LimitTileSeries = {
  key: string;
  label: string;
  threshold: number | null;
  points: MetricSeriesPoint[];
  failed?: boolean;
};

export function isLimitComponent(key: string): boolean {
  const capability = getCapability(key);
  return !!capability && capability.area === "limits" && !capability.binding.compositeOf;
}

export function isLimitsComposite(key: string): boolean {
  const capability = getCapability(key);
  return !!capability && capability.area === "limits" && !!capability.binding.compositeOf;
}

export function hasTileData(points: MetricSeriesPoint[]): boolean {
  return points.some((p) => p.value !== null);
}
