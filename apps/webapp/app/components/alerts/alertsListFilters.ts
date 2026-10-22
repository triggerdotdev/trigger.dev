import parse from "parse-duration";
import {
  compareAlertRows,
  rowMatchesStatus,
  type AlertListRow,
  type AlertListRowStatus,
} from "~/presenters/v3/alertListRow";
import { isAlertArea, type AlertArea } from "./domainIcons";

export type AreaFilterValue = AlertArea | "unknown";

export function isWithinPeriod(
  lastActivityAt: Date | string,
  period: string | undefined,
  now: number = Date.now()
): boolean {
  if (!period) return true;
  const ms = parse(period);
  if (!ms) return true;
  return new Date(lastActivityAt).getTime() >= now - ms;
}

export function matchesAreas(area: string, areas: AreaFilterValue[]): boolean {
  if (areas.length === 0) return true;
  return isAlertArea(area) ? areas.includes(area) : areas.includes("unknown");
}

export const MAX_LIST_ALERTS = 500;
export const DEFAULT_PERIOD = "7d";
const ALL_PERIODS = "all";
const STATUS_VALUES = ["needs_attention", "active", "inactive"];
const AREA_VALUES = ["queues", "errors", "runs", "health", "unknown"];

function splitList(value: string | null, allowed: string[]): string[] {
  if (!value) return [];
  return value.split(",").filter((v) => allowed.includes(v));
}

function parseTimestamp(value: string | null): number | undefined {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function parseAlertsListSearchParams(params: URLSearchParams) {
  const period = params.get("period");
  const from = parseTimestamp(params.get("from"));
  const to = parseTimestamp(params.get("to"));
  const custom = from !== undefined || to !== undefined;
  return {
    statuses: splitList(params.get("statuses"), STATUS_VALUES),
    areas: splitList(params.get("areas"), AREA_VALUES) as AreaFilterValue[],
    period: custom
      ? undefined
      : period === ALL_PERIODS
        ? undefined
        : period && parse(period)
          ? period
          : DEFAULT_PERIOD,
    from,
    to,
  };
}

export function serializeAlertsListFilters(filters: {
  statuses?: string[];
  areas?: string[];
  period?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if ("statuses" in filters) {
    out.statuses = filters.statuses?.length ? filters.statuses.join(",") : undefined;
  }
  if ("areas" in filters) {
    out.areas = filters.areas?.length ? filters.areas.join(",") : undefined;
  }
  if ("period" in filters) {
    const custom = filters.from !== undefined || filters.to !== undefined;
    out.period =
      custom || filters.period === DEFAULT_PERIOD ? undefined : (filters.period ?? ALL_PERIODS);
    out.from = filters.from;
    out.to = filters.to;
  }
  return out;
}

export function filterAlertRows(
  alerts: AlertListRow[],
  filters: {
    search: string;
    statuses: AlertListRowStatus[];
    areas: AreaFilterValue[];
    period: string | undefined;
    from?: number;
    to?: number;
  },
  now?: number
): AlertListRow[] {
  const { search, statuses, areas, period, from, to } = filters;
  const needle = search.trim().toLowerCase();
  return alerts
    .filter((alert) => {
      if (!matchesAreas(alert.area, areas)) return false;
      const at = alert.lastEventAt ?? alert.lastActivityAt;
      if (!isWithinPeriod(at, period, now)) return false;
      const time = new Date(at).getTime();
      if (from !== undefined && time < from) return false;
      if (to !== undefined && time > to) return false;
      if (statuses.length > 0 && !statuses.some((s) => rowMatchesStatus(alert, s))) return false;
      if (needle && !`${alert.name} ${alert.conditionSummary}`.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    })
    .sort(compareAlertRows);
}
