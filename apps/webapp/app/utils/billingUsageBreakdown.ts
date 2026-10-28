import type {
  BillingMonthlyUsage,
  BillingMonthlyUsageLine,
  BillingProjectUsageLine,
} from "@trigger.dev/billing";
import type {
  BillingOrganizationProjectUsage,
  BillingUsageProject,
} from "~/services/billingUsage.server";

export type UsageDimension = "project" | "usageType" | "machine" | "environment" | "region";

export type UsageType = "compute" | "runs";

export type UsageLeaf = {
  dimensions: Record<UsageDimension, string | null>;
  usageType: UsageType | null;
  unitPrice: number | null;
  cost: number;
  computeMs: number;
  runs: number;
};

export type UsageNode = {
  id: string;
  dimension: UsageDimension;
  value: string;
  usageType: UsageType | null;
  unitPrice: number | null;
  cost: number;
  computeMs: number;
  runs: number;
  children: UsageNode[];
};

export type UsageTotals = Pick<UsageNode, "cost" | "computeMs" | "runs">;

export type UsageSortKey = "cost" | "computeMs";

export type MonthlyUsageLine = BillingMonthlyUsageLine;

export type ProjectUsageLine = BillingProjectUsageLine;

export type UsageProject = BillingUsageProject;

export type MonthlyUsageView = BillingMonthlyUsage;

export type ProjectUsageView = BillingOrganizationProjectUsage;

export const UNSPLIT_VALUE = "";

export const USAGE_DIMENSIONS: UsageDimension[] = ["usageType", "machine", "environment", "region"];

export const PROJECT_DIMENSIONS: UsageDimension[] = ["project", "machine", "environment", "region"];

export const DEFAULT_USAGE_GROUPINGS: UsageDimension[] = ["region", "machine", "usageType"];

export const DEFAULT_PROJECT_GROUPINGS: UsageDimension[] = ["project", "region", "machine"];

export function monthlyUsageLeaves(lines: MonthlyUsageLine[]): UsageLeaf[] {
  return lines.map((line) => ({
    dimensions: {
      project: null,
      usageType: line.usageType,
      machine: line.machinePreset,
      environment: line.environmentType,
      region: line.region,
    },
    usageType: line.usageType,
    unitPrice: line.unitPrice,
    cost: line.total,
    computeMs: line.usageType === "compute" ? line.quantity : 0,
    runs: line.usageType === "runs" ? line.quantity : 0,
  }));
}

export function projectUsageLeaves(lines: ProjectUsageLine[]): UsageLeaf[] {
  return lines.map((line) => ({
    dimensions: {
      project: line.projectId,
      usageType: null,
      machine: line.machinePreset,
      environment: line.environmentType,
      region: line.region,
    },
    usageType: null,
    unitPrice: null,
    cost: 0,
    computeMs: line.computeMs,
    runs: line.runs,
  }));
}

export function sumUsage(leaves: Pick<UsageLeaf, "cost" | "computeMs" | "runs">[]): UsageTotals {
  return leaves.reduce<UsageTotals>(
    (totals, leaf) => ({
      cost: totals.cost + leaf.cost,
      computeMs: totals.computeMs + leaf.computeMs,
      runs: totals.runs + leaf.runs,
    }),
    { cost: 0, computeMs: 0, runs: 0 }
  );
}

function uniform<T>(values: T[]): T | null {
  const distinct = new Set(values);
  if (distinct.size !== 1) return null;
  return values[0];
}

export function buildUsageTree(
  leaves: UsageLeaf[],
  groupings: UsageDimension[],
  sortBy: UsageSortKey,
  parentId = ""
): UsageNode[] {
  const [dimension, ...rest] = groupings;
  if (!dimension) return [];
  const isTopLevel = parentId === "";
  const hasValuesBelow = groupings.some((next) =>
    leaves.some((leaf) => leaf.dimensions[next] !== null)
  );
  if (
    leaves.every((leaf) => leaf.dimensions[dimension] === null) &&
    (hasValuesBelow || !isTopLevel)
  ) {
    return buildUsageTree(leaves, rest, sortBy, parentId);
  }

  const buckets = new Map<string, UsageLeaf[]>();
  for (const leaf of leaves) {
    const value = leaf.dimensions[dimension] ?? UNSPLIT_VALUE;
    buckets.set(value, [...(buckets.get(value) ?? []), leaf]);
  }

  return [...buckets.entries()]
    .map(([value, items]): UsageNode => {
      const id = `${parentId}/${dimension}:${value}`;
      const usageType = uniform(items.map((item) => item.usageType));
      return {
        id,
        dimension,
        value,
        usageType,
        unitPrice: usageType ? uniform(items.map((item) => item.unitPrice)) : null,
        ...sumUsage(items),
        children: buildUsageTree(items, rest, sortBy, id),
      };
    })
    .sort((a, b) => b[sortBy] - a[sortBy]);
}

export function parseGroupings(
  raw: string | undefined,
  available: UsageDimension[],
  fallback: UsageDimension[]
): UsageDimension[] {
  const defaults = fallback.filter((dimension) => available.includes(dimension));
  if (!raw) return defaults.length > 0 ? defaults : available.slice(0, 1);

  const parsed = [
    ...new Set(
      raw
        .split(",")
        .filter((value): value is UsageDimension => available.includes(value as UsageDimension))
    ),
  ];
  return parsed.length > 0 ? parsed : defaults;
}

export function moveGrouping(
  groupings: UsageDimension[],
  dimension: UsageDimension,
  delta: number
): UsageDimension[] {
  const from = groupings.indexOf(dimension);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= groupings.length) return groupings;

  const next = [...groupings];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function removeGrouping(
  groupings: UsageDimension[],
  dimension: UsageDimension
): UsageDimension[] {
  if (groupings.length <= 1) return groupings;
  return groupings.filter((value) => value !== dimension);
}

export function addGrouping(
  groupings: UsageDimension[],
  dimension: UsageDimension
): UsageDimension[] {
  if (groupings.includes(dimension)) return groupings;
  return [...groupings, dimension];
}

export function dropGrouping(
  groupings: UsageDimension[],
  dragged: UsageDimension,
  target: UsageDimension
): UsageDimension[] {
  const from = groupings.indexOf(dragged);
  const to = groupings.indexOf(target);
  if (from < 0 || to < 0 || from === to) return groupings;

  const next = groupings.filter((dimension) => dimension !== dragged);
  next.splice(to, 0, dragged);
  return next;
}

export function restoreGrouping(
  stored: UsageDimension[],
  edited: UsageDimension[],
  hidden: UsageDimension
): UsageDimension[] {
  const index = stored.indexOf(hidden);
  if (index < 0 || edited.includes(hidden)) return edited;

  const next = [...edited];
  next.splice(Math.min(index, next.length), 0, hidden);
  return next;
}

export function usageProjects(
  usage: Pick<ProjectUsageView, "projects" | "projectIds">
): UsageProject[] {
  const known = new Set(usage.projects.map((project) => project.id));
  const unnamed = usage.projectIds
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, slug: "", externalRef: id, deleted: false }));
  return [...usage.projects, ...unnamed];
}

/**
 * What Metronome bills for usage: the usage less the credit it actually applied, never less than zero. A credit
 * only pays usage that ran while its contract was active, so the credit available can't stand in for it.
 */
export function usageDue(usage: Pick<MonthlyUsageView, "total" | "creditsApplied">): number {
  return Math.max(0, usage.total - usage.creditsApplied);
}
