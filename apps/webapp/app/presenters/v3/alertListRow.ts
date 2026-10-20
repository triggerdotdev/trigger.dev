import type { AlertParams } from "@internal/alert-contracts";
import { episodeFromTimes, type AlertEpisodeState } from "~/components/alerts/alertStateOutcome";
import { CLEARING_EVENTS } from "~/components/alerts/alertSeriesTypes";

export type AlertListRowStatus = "needs_attention" | "active" | "inactive";

export type AlertEpisodeSummary =
  | { kind: "raised"; at: Date | string; recoveredAt?: Date | string }
  | { kind: "resolved"; at: Date | string; recoveredAt?: Date | string }
  | { kind: "stopped"; at: Date | string }
  | { kind: "expired"; at: Date | string | null };

export type AlertStateBucket = { date: number; raised: boolean };

export type AlertListRow = {
  id: string;
  name: string;
  area: string;
  conditionSummary: string;
  capabilityKey: string;
  capabilityTitle: string;
  environmentId: string;
  scope: AlertParams["scope"] | undefined;
  status: AlertListRowStatus;
  hasChannelIssue: boolean;
  inactiveReason?: "completed" | "expired" | "stopped";
  lastEventAt: Date | string | null;
  notifierCount: number;
  notifierKeys?: string[];
  episode?: AlertEpisodeSummary;
  expiresAt: Date | string | null;
  lastActivityAt: Date | string;
  stateBuckets?: AlertStateBucket[];
};

export function rowMatchesStatus(row: AlertListRow, status: AlertListRowStatus): boolean {
  return row.status === status;
}

const STATUS_SORT_RANK: Record<AlertListRowStatus, number> = {
  needs_attention: 0,
  active: 1,
  inactive: 2,
};

function toEpoch(d: Date | string): number {
  return typeof d === "string" ? new Date(d).getTime() : d.getTime();
}

export function compareAlertRows(a: AlertListRow, b: AlertListRow): number {
  const rankDiff = STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status];
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = toEpoch(b.lastActivityAt) - toEpoch(a.lastActivityAt);
  if (timeDiff !== 0) return timeDiff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const RAISING_EVENTS = new Set(["raised"]);

export function buildStateBuckets(
  events: Array<{ type: string; at: Date }>,
  sinceMs: number,
  bucketMs: number,
  count: number,
  raisedSince?: number
): AlertStateBucket[] {
  const sorted = events
    .filter((e) => RAISING_EVENTS.has(e.type) || CLEARING_EVENTS.has(e.type))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  let raised = false;
  let i = 0;
  while (i < sorted.length && sorted[i]!.at.getTime() < sinceMs) {
    raised = RAISING_EVENTS.has(sorted[i]!.type);
    i++;
  }
  const buckets: AlertStateBucket[] = [];
  for (let b = 0; b < count; b++) {
    const start = sinceMs + b * bucketMs;
    let any = raised;
    while (i < sorted.length && sorted[i]!.at.getTime() < start + bucketMs) {
      raised = RAISING_EVENTS.has(sorted[i]!.type);
      any ||= raised;
      i++;
    }
    if (raisedSince !== undefined && start + bucketMs > raisedSince) any = true;
    buckets.push({ date: start, raised: any });
  }
  return buckets;
}

export function episodeSummary(params: {
  status: AlertListRowStatus;
  inactiveReason?: AlertListRow["inactiveReason"];
  raisedAt: Date | null;
  recoveredAt: Date | null;
  resolvedAt: Date | null;
  stoppedAt: Date | null;
  expiresAt: Date | null;
  observedCondition?: AlertEpisodeState["observedCondition"];
}): AlertEpisodeSummary | undefined {
  const recoveredAt =
    episodeFromTimes(
      { raisedAt: params.raisedAt, recoveredAt: params.recoveredAt },
      params.observedCondition
        ? {
            attention: params.status === "needs_attention" ? "needs_attention" : "clear",
            observedCondition: params.observedCondition,
          }
        : undefined
    ).recoveredAt ?? undefined;
  if (params.status === "needs_attention" && params.raisedAt) {
    return { kind: "raised", at: params.raisedAt, recoveredAt };
  }
  if (params.status !== "inactive") return undefined;

  switch (params.inactiveReason) {
    case "completed":
      return params.resolvedAt
        ? {
            kind: "resolved",
            at: params.resolvedAt,
            recoveredAt,
          }
        : undefined;
    case "stopped":
      return params.stoppedAt ? { kind: "stopped", at: params.stoppedAt } : undefined;
    case "expired":
      return { kind: "expired", at: params.expiresAt };
    default:
      return undefined;
  }
}
