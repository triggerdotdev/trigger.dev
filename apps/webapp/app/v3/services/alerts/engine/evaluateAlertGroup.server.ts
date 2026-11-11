import { conditionSchema, getCapability } from "@internal/alert-contracts";
import { boundedIn, type PrismaClientOrTransaction } from "~/db.server";
import type { Alert } from "../storage/alertStore.server";
import { resolveAlertCapability } from "../queryAlerts/resolveAlertCapability.server";
import { alertDisplayName } from "../alertDisplayName";
import type { BindingResult } from "./evaluateAlert.server";

type MemberOutcome = "met" | "not_met" | "unavailable";

type MemberRow = Pick<
  Alert,
  | "lifecycle"
  | "expiresAt"
  | "observedCondition"
  | "capabilityKey"
  | "query"
  | "params"
  | "condition"
> & {
  evaluatorState: unknown;
};

function memberOutcome(
  member: MemberRow,
  now: Date,
  group: { cadenceSec: number; resolvedAt: Date | null }
): MemberOutcome {
  if (member.lifecycle !== "active") return "unavailable";
  if (member.expiresAt && member.expiresAt.getTime() <= now.getTime()) return "unavailable";
  if ((member.evaluatorState as { lastError?: unknown } | null)?.lastError) return "unavailable";
  if ((member.condition as { kind?: string } | null)?.kind === "occurrence") {
    const cadenceSec = Math.max(
      resolveAlertCapability(member)?.capability.minCadenceSec ??
        getCapability(member.capabilityKey)?.minCadenceSec ??
        0,
      group.cadenceSec
    );
    const seenAt = Date.parse(
      (member.evaluatorState as { occurrenceSeenAt?: string } | null)?.occurrenceSeenAt ?? ""
    );
    const since = Math.max(
      now.getTime() - cadenceSec * 2 * 1000,
      (group.resolvedAt?.getTime() ?? -Infinity) + 1
    );
    return seenAt >= since ? "met" : "not_met";
  }
  return member.observedCondition === "unknown" ? "unavailable" : member.observedCondition;
}

function groupOutcome(
  mode: "any" | "all",
  outcomes: MemberOutcome[]
): { outcome: MemberOutcome; reason?: string } {
  const available = outcomes.filter((o) => o !== "unavailable");
  if (available.length === 0) return { outcome: "unavailable", reason: "members_unavailable" };
  const met =
    mode === "all" ? available.every((o) => o === "met") : available.some((o) => o === "met");
  return { outcome: met ? "met" : "not_met" };
}

export async function evaluateAlertGroup(
  db: PrismaClientOrTransaction,
  alert: Alert,
  now = new Date()
): Promise<BindingResult> {
  const condition = conditionSchema.parse(alert.condition);
  const state = condition.kind === "state" ? condition : undefined;
  const rows = await db.alert.findMany({
    where: {
      id: { in: boundedIn(state?.memberAlertIds ?? []) },
      environmentId: alert.environmentId,
      groupId: alert.id,
    },
    select: {
      id: true,
      name: true,
      capabilityKey: true,
      params: true,
      lifecycle: true,
      expiresAt: true,
      observedCondition: true,
      evaluatorState: true,
      condition: true,
      query: true,
    },
  });
  const members = Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        outcome: memberOutcome(row as MemberRow, now, {
          cadenceSec: getCapability(alert.capabilityKey)?.minCadenceSec ?? 0,
          resolvedAt: alert.resolvedAt,
        }),
        name: alertDisplayName(row),
        capabilityKey: row.capabilityKey,
      },
    ])
  );
  const { outcome, reason } = groupOutcome(
    state?.compositeMode ?? "any",
    Object.values(members).map((m) => m.outcome)
  );
  return {
    result: {
      kind: "stateful",
      outcome,
      facts: { members, ...(reason ? { unavailableReason: reason } : {}) },
    },
  };
}
