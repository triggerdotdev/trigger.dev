import { Result } from "neverthrow";
import {
  DEFAULT_PROJECT_GROUPINGS,
  DEFAULT_USAGE_GROUPINGS,
  parseGroupings,
  PROJECT_DIMENSIONS,
  USAGE_DIMENSIONS,
  type UsageDimension,
} from "./billingUsageBreakdown";
import type { ProjectMetric } from "./billingUsageChart";
import type { ComputeTimeFormat } from "./billingUsageFormat";

export type UsagePageTab = "usage" | "projects" | "addons";

const TABS: UsagePageTab[] = ["usage", "projects", "addons"];

export type UsagePageState = {
  tab: UsagePageTab;
  usageGroupings: UsageDimension[];
  projectGroupings: UsageDimension[];
  project: string;
  metric: ProjectMetric;
  timeFormat: ComputeTimeFormat;
};

export const USAGE_PAGE_PARAMS = {
  tab: "tab",
  month: "month",
  usageGroupings: "groups",
  projectGroupings: "projectGroups",
  project: "project",
  metric: "metric",
  timeFormat: "time",
} as const;

export const ALL_PROJECTS = "all";

export function parseUsagePageState(search: URLSearchParams, projectIds: string[]): UsagePageState {
  const project = search.get(USAGE_PAGE_PARAMS.project);

  return {
    tab: TABS.find((tab) => tab === search.get(USAGE_PAGE_PARAMS.tab)) ?? "usage",
    usageGroupings: parseGroupings(
      search.get(USAGE_PAGE_PARAMS.usageGroupings) ?? undefined,
      USAGE_DIMENSIONS,
      DEFAULT_USAGE_GROUPINGS
    ),
    projectGroupings: parseGroupings(
      search.get(USAGE_PAGE_PARAMS.projectGroupings) ?? undefined,
      PROJECT_DIMENSIONS,
      DEFAULT_PROJECT_GROUPINGS
    ),
    project: project && projectIds.includes(project) ? project : ALL_PROJECTS,
    metric: search.get(USAGE_PAGE_PARAMS.metric) === "runs" ? "runs" : "computeMs",
    timeFormat: search.get(USAGE_PAGE_PARAMS.timeFormat) === "readable" ? "readable" : "ms",
  };
}

export function shouldReloadUsage(currentUrl: URL, nextUrl: URL): boolean | undefined {
  if (currentUrl.pathname !== nextUrl.pathname) return undefined;
  if (currentUrl.search === nextUrl.search) return undefined;

  const month = USAGE_PAGE_PARAMS.month;
  return currentUrl.searchParams.get(month) !== nextUrl.searchParams.get(month);
}

type PendingResult = { ok: true; value: { pendingDays?: number } } | { ok: false };

/** Settled days still being fetched. Each read fetches the same days, so a day counts once; a failed read has none. */
export function pendingUsageDays(...results: PendingResult[]): number {
  return Math.max(0, ...results.map(pendingOf));
}

/** Days still pending summed over the reads, so a poll that moves any read along counts as progress. */
export function pendingUsageFetches(...results: PendingResult[]): number {
  return results.reduce((sum, result) => sum + pendingOf(result), 0);
}

function pendingOf(result: PendingResult): number {
  return result.ok ? (result.value.pendingDays ?? 0) : 0;
}

/** Poll again only while days are pending and the last poll fetched some, so a stuck store can't loop. */
export function shouldPollUsage(pending: number, previousPending: number | undefined): boolean {
  if (pending === 0) return false;
  return previousPending === undefined || pending < previousPending;
}

export type GroupingsParam = "usageGroupings" | "projectGroupings";

export type GroupingsStore = Pick<Storage, "getItem" | "setItem">;

const GROUPINGS: Record<
  GroupingsParam,
  { storageKey: string; available: UsageDimension[]; fallback: UsageDimension[] }
> = {
  usageGroupings: {
    storageKey: "tdev:billing-usage:groups",
    available: USAGE_DIMENSIONS,
    fallback: DEFAULT_USAGE_GROUPINGS,
  },
  projectGroupings: {
    storageKey: "tdev:billing-usage:projectGroups",
    available: PROJECT_DIMENSIONS,
    fallback: DEFAULT_PROJECT_GROUPINGS,
  },
};

export function browserGroupingsStore(): GroupingsStore | undefined {
  if (typeof window === "undefined") return undefined;
  return Result.fromThrowable(() => window.localStorage)().unwrapOr(undefined);
}

export function writeStoredGroupings(
  store: GroupingsStore | undefined,
  param: GroupingsParam,
  groupings: UsageDimension[]
): void {
  if (!store) return;
  Result.fromThrowable(() => store.setItem(GROUPINGS[param].storageKey, groupings.join(",")))();
}

export function storedGroupingsToRestore(
  search: URLSearchParams,
  store: GroupingsStore | undefined
): Partial<Record<string, string>> {
  if (!store) return {};

  const restore: Partial<Record<string, string>> = {};
  for (const param of Object.keys(GROUPINGS) as GroupingsParam[]) {
    const urlParam = USAGE_PAGE_PARAMS[param];
    if (search.has(urlParam)) continue;

    const stored = Result.fromThrowable(() =>
      store.getItem(GROUPINGS[param].storageKey)
    )().unwrapOr(null);
    if (!stored) continue;

    const { available, fallback } = GROUPINGS[param];
    restore[urlParam] = parseGroupings(stored, available, fallback).join(",");
  }
  return restore;
}
