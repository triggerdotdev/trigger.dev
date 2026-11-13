import type { AlertCreatedBlock, MonitoringPlanItem } from "@internal/dashboard-agent-contracts";
import { useCallback, useState } from "react";

export type PlanItemStatus = { kind: "created"; alertId?: string; block?: AlertCreatedBlock };

export type PlanItemRef = { key: string; item: MonitoringPlanItem; lineage?: string };

type PlanGroupCreated = { alertId: string; block?: AlertCreatedBlock };

export type PlanFlow = {
  planKey: string;
  unselected: string[];
  unavailable?: string[];
  mode?: "combined" | "separate";
  notifiers?: string[];
  name?: string;
  open?: boolean;
  group?: PlanGroupCreated;
};

type PlanState = {
  chatId?: string;
  byKey: Record<string, PlanItemStatus>;
  createdByDraft: Record<string, PlanItemStatus>;
  flows: Record<string, PlanFlow>;
};

// A revised plan starts closed; per-item choices carry over by draft identity.
function flowOf(state: PlanState, lineage: string, planKey: string): PlanFlow {
  const stored = state.flows[lineage];
  if (stored?.planKey === planKey) return stored;
  return {
    planKey,
    unselected: stored?.unselected ?? [],
    notifiers: stored?.notifiers,
  };
}

export function planItemKey(planKey: string, itemId: string): string {
  return `${planKey}:${itemId}`;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function draftIdentity({ item, lineage }: PlanItemRef): string {
  const identity = `${item.id}:${stableHash(sortedJson(item.draft))}`;
  return lineage ? `${lineage}:${identity}` : identity;
}

export function createdAlertKey(ref: PlanItemRef): string {
  return draftIdentity(ref);
}

export function useMonitoringPlanState(chatId: string | undefined) {
  const fresh = (): PlanState => ({ chatId, byKey: {}, createdByDraft: {}, flows: {} });
  const [stored, setStored] = useState<PlanState>(fresh);
  const state = stored.chatId === chatId ? stored : fresh();

  const update = useCallback(
    (next: (state: PlanState) => PlanState) =>
      setStored((prev) =>
        next(prev.chatId === chatId ? prev : { chatId, byKey: {}, createdByDraft: {}, flows: {} })
      ),
    [chatId]
  );

  const markCreated = useCallback(
    (ref: PlanItemRef, alertId?: string, block?: AlertCreatedBlock) =>
      update((s) => {
        const created: PlanItemStatus = { kind: "created", alertId, block };
        return {
          ...s,
          byKey: { ...s.byKey, [ref.key]: created },
          createdByDraft: { ...s.createdByDraft, [draftIdentity(ref)]: created },
        };
      }),
    [update]
  );

  const updateFlow = useCallback(
    (lineage: string, planKey: string, patch: Partial<PlanFlow>) =>
      update((s) => ({
        ...s,
        flows: { ...s.flows, [lineage]: { ...flowOf(s, lineage, planKey), ...patch } },
      })),
    [update]
  );

  const statusFor = useCallback(
    (ref: PlanItemRef): PlanItemStatus | undefined =>
      state.byKey[ref.key] ?? state.createdByDraft[draftIdentity(ref)],
    [state]
  );

  const flowFor = useCallback(
    (lineage: string, planKey: string) => flowOf(state, lineage, planKey),
    [state]
  );

  const createdHere = useCallback(
    (ref: PlanItemRef): PlanItemStatus | undefined => state.byKey[ref.key],
    [state]
  );

  return { statusFor, createdHere, markCreated, flowFor, updateFlow };
}

export type MonitoringPlanState = ReturnType<typeof useMonitoringPlanState>;
