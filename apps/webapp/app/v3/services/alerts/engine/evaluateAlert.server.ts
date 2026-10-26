import type { PrismaClientOrTransaction } from "~/db.server";
import {
  type Alert,
  applyEvaluationOutcome,
  listActiveSeenOccurrenceKeys,
  releaseLeaseForRetry,
} from "../storage/alertStore.server";
import {
  type AlertCapability,
  type AlertEventType,
  type EvaluationResult,
  type NotifierRef,
  transition,
  type AlertState,
  type Behavior,
} from "@internal/alert-contracts";
import { env } from "~/env.server";
import {
  DEFAULT_DISTRIBUTION_WINDOW_SEC,
  capCadenceSec,
  laneRetryAt,
  nextEvaluationAt as computeNextEvaluationAt,
} from "./alertSchedule";
import { resolveAlertCapability } from "../queryAlerts/resolveAlertCapability.server";

function isQueryConcurrencyRejection(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>).__queryConcurrencyRejection === true
  );
}

async function defaultEnqueueDelivery(params: { eventId: string; eventAt: Date }): Promise<void> {
  const { enqueueAlertEventDelivery } =
    await import("../delivery/enqueueAlertEventDelivery.server");
  return enqueueAlertEventDelivery(params);
}

const UNAVAILABLE_REASON_CHARS = 300;

export type CompositeHysteresisState = {
  consecutiveMet: number;
  consecutiveNotMet: number;
};

const FRESH_HYSTERESIS: CompositeHysteresisState = {
  consecutiveMet: 0,
  consecutiveNotMet: 0,
};

export function applyCompositeHysteresis(
  prev: CompositeHysteresisState,
  rawOutcome: "met" | "not_met" | "unavailable"
): { state: CompositeHysteresisState; effective: "met" | "not_met" | "unchanged" } {
  if (rawOutcome === "unavailable") {
    return { state: { consecutiveMet: 0, consecutiveNotMet: 0 }, effective: "unchanged" };
  }
  if (rawOutcome === "met") {
    const consecutiveMet = prev.consecutiveMet + 1;
    return {
      state: { consecutiveMet, consecutiveNotMet: 0 },
      effective: consecutiveMet >= 2 ? "met" : "unchanged",
    };
  }
  const consecutiveNotMet = prev.consecutiveNotMet + 1;
  return {
    state: { consecutiveMet: 0, consecutiveNotMet },
    effective: consecutiveNotMet >= 2 ? "not_met" : "unchanged",
  };
}

export type BindingResult = {
  result: EvaluationResult;
  evaluatorStatePatch?: Record<string, unknown>;
};

export function queryResultToBindingResult(qr: {
  status: string;
  facts: Record<string, unknown>;
}): BindingResult {
  return {
    result: {
      kind: "stateful",
      outcome: qr.status,
      facts: qr.facts,
    } as EvaluationResult,
  };
}

export type EvaluateBindingFn = (
  alert: Alert,
  capability: AlertCapability
) => Promise<BindingResult>;

export interface EvaluateAlertDeps {
  db: PrismaClientOrTransaction;
  evaluateBinding: EvaluateBindingFn;
  enqueueDelivery?: (params: { eventId: string; eventAt: Date }) => Promise<void>;
  windowSec?: number;
  logger?: {
    debug: (message: string, ...args: any[]) => void;
    error: (message: string, ...args: any[]) => void;
  };
}

export interface EvaluateAlertOutcome {
  applied: boolean;
  bindingFailed?: boolean;
  laneRejected?: boolean;
  unavailableReason?: string;
  unavailableCode?: string;
  events: AlertEventType[];
  deliveryCount: number;
  alert?: Alert | null;
}

export async function evaluateAlert(
  alert: Alert & { evaluationLeaseId: string },
  deps: EvaluateAlertDeps
): Promise<EvaluateAlertOutcome> {
  const windowSec = deps.windowSec ?? DEFAULT_DISTRIBUTION_WINDOW_SEC;
  const resolved = resolveAlertCapability(alert);
  if (!resolved) {
    deps.logger?.error("unknown capability", { capabilityKey: alert.capabilityKey });
    const released = await releaseLeaseToNextCadence(alert, deps);
    return { applied: released, events: [], deliveryCount: 0 };
  }
  const { capability } = resolved;

  let result: EvaluationResult;
  let evaluatorStatePatch: Record<string, unknown> | undefined;
  try {
    ({ result, evaluatorStatePatch } = resolved.unavailable
      ? {
          result: {
            kind: "stateful",
            outcome: "unavailable",
            facts: {
              unavailableReason: resolved.unavailable.reason,
              unavailableCode: resolved.unavailable.code,
            },
          },
          evaluatorStatePatch: alert.evaluatorState ?? undefined,
        }
      : await deps.evaluateBinding(alert, capability));
  } catch (err) {
    const laneRejected = isQueryConcurrencyRejection(err);
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.length > 512 ? raw.slice(0, 512) : raw;
    if (!laneRejected) {
      deps.logger?.error("alerts.evaluate.binding_failed", {
        alertId: alert.id,
        capabilityKey: alert.capabilityKey,
        error: err,
      });
    }
    const now = new Date();
    if (laneRejected) {
      const released = await releaseLeaseForRetry(deps.db, {
        alertId: alert.id,
        leaseId: alert.evaluationLeaseId,
        nextEvaluationAt: laneRetryAt({ now }),
      });
      if (!released) {
        deps.logger?.debug("alerts.evaluate.lane_retry_lease_lost", { alertId: alert.id });
      }
      return {
        applied: released,
        laneRejected: true,
        unavailableReason: "lane_rejected",
        events: [],
        deliveryCount: 0,
      };
    }
    const failed = await applyEvaluationOutcome(deps.db, {
      alertId: alert.id,
      leaseId: alert.evaluationLeaseId,
      patch: {
        pendingMetSince: null,
        nextEvaluationAt: scheduleNext(alert, capability.minCadenceSec, now, windowSec),
        evaluatorState: {
          ...(alert.evaluatorState as Record<string, unknown> | null),
          ...(capability.binding.compositeOf
            ? { compositeHysteresis: { consecutiveMet: 0, consecutiveNotMet: 0 } }
            : {}),
          lastError: { reason: `template_error: ${message}`.slice(0, 120), at: now.toISOString() },
        },
      },
      events: [],
      deliveries: [],
    });
    return {
      applied: failed.applied,
      ...(failed.applied ? { alert: failed.alert } : {}),
      bindingFailed: true,
      unavailableReason: `template_error: ${message}`.slice(0, 120),
      events: [],
      deliveryCount: 0,
    };
  }

  let unavailableReason: string | null = null;
  let unavailableCode: string | undefined;
  if (result.kind === "stateful" && result.outcome === "unavailable") {
    const facts = result.facts as Record<string, unknown>;
    const raw = typeof facts.unavailableReason === "string" ? facts.unavailableReason : "unknown";
    unavailableReason = raw.slice(0, UNAVAILABLE_REASON_CHARS);
    unavailableCode = typeof facts.unavailableCode === "string" ? facts.unavailableCode : undefined;
  }

  if (capability.binding.compositeOf && result.kind === "stateful") {
    const prevHyst =
      (alert.evaluatorState as Record<string, unknown> | null)?.compositeHysteresis != null
        ? ((alert.evaluatorState as Record<string, unknown>)
            .compositeHysteresis as CompositeHysteresisState)
        : FRESH_HYSTERESIS;

    const components = (result.facts as Record<string, unknown>).components as
      | Record<string, { outcome: string; effectiveParams: Record<string, number> }>
      | undefined;
    const lastEffectiveParams: Record<string, number> = {};
    if (components) {
      for (const comp of Object.values(components)) {
        if (comp.effectiveParams) {
          Object.assign(lastEffectiveParams, comp.effectiveParams);
        }
      }
    }

    evaluatorStatePatch = {
      ...evaluatorStatePatch,
      lastComponents: components ?? {},
      lastEffectiveParams,
      observedAt: new Date().toISOString(),
    };

    if (
      result.outcome === "met" ||
      result.outcome === "not_met" ||
      result.outcome === "unavailable"
    ) {
      const { state, effective } = applyCompositeHysteresis(prevHyst, result.outcome);
      evaluatorStatePatch = { ...evaluatorStatePatch, compositeHysteresis: state };

      if (effective === "unchanged") {
        result = { kind: "stateful", outcome: "unavailable", facts: result.facts };
      } else {
        result = { kind: "stateful", outcome: effective, facts: result.facts };
      }
    }
  }

  const condition = alert.condition as Record<string, unknown>;
  const holdSec = typeof condition.holdSec === "number" ? condition.holdSec : 0;

  const prevState: AlertState = {
    lifecycle: alert.lifecycle as AlertState["lifecycle"],
    attention: alert.attention as AlertState["attention"],
    observedCondition: alert.observedCondition as AlertState["observedCondition"],
    pendingMetSince: alert.pendingMetSince,
  };

  const behavior: Behavior = {
    expiresAt: alert.expiresAt?.toISOString(),
  };

  const now = new Date();
  if (result.kind === "occurrence") {
    const dropped = result.occurrences.filter((o) => !o.sourceEventId).length;
    if (dropped > 0) {
      deps.logger?.error("alerts.occurrence_source_event_id_missing", {
        alertId: alert.id,
        dropped,
      });
    }
    const byKey = new Map<string, (typeof result.occurrences)[number]>();
    for (const o of result.occurrences) {
      if (o.sourceEventId && !byKey.has(o.sourceEventId)) byKey.set(o.sourceEventId, o);
    }
    const seen = await listActiveSeenOccurrenceKeys(deps.db, {
      alertId: alert.id,
      keys: Array.from(byKey.keys()),
      now,
    });
    result = {
      ...result,
      occurrences: Array.from(byKey.values()).filter((o) => !seen.has(o.sourceEventId)),
    };
  }
  const { next, events, notify, latestOccurrenceAt } = transition(prevState, {
    result,
    now,
    holdSec,
    behavior,
  });

  const conditionChanged = next.observedCondition !== prevState.observedCondition;
  const patch: Parameters<typeof applyEvaluationOutcome>[1]["patch"] = {
    attention: next.attention,
    observedCondition: next.observedCondition,
    pendingMetSince: next.pendingMetSince,
    lifecycle: next.lifecycle,
    nextEvaluationAt: scheduleNext(alert, capability.minCadenceSec, now, windowSec),
    ...(conditionChanged ? { observedConditionChangedAt: now } : {}),
    evaluatorState: {
      ...(evaluatorStatePatch ?? {}),
      lastError: unavailableReason
        ? { reason: unavailableReason, code: unavailableCode, at: now.toISOString() }
        : null,
    },
  };

  const outcomeEvents = buildOutcomeEvents(events, result, now, capability);

  const deliveries: Array<{ alertEventIndex: number; notifier: NotifierRef }> = [];
  const notifiers = (alert.notifiers ?? []) as NotifierRef[];
  for (let i = 0; i < events.length; i++) {
    if (events[i] === "raised" && notify) {
      for (const notifier of notifiers) {
        deliveries.push({ alertEventIndex: i, notifier });
      }
    }
  }

  const outcome = await applyEvaluationOutcome(deps.db, {
    alertId: alert.id,
    leaseId: alert.evaluationLeaseId,
    patch,
    events: outcomeEvents,
    deliveries,
    ...(result.kind === "occurrence"
      ? {
          occurrences: result.occurrences.map(({ sourceEventId, rowTime, expiresAt }) => ({
            sourceEventId,
            rowTime,
            expiresAt,
          })),
          occurrenceCounters: {
            add: result.occurrences.length,
            latestAt: latestOccurrenceAt ?? null,
            resetSinceRaise: events.includes("raised"),
          },
        }
      : {}),
  });

  if (!outcome.applied) {
    return { applied: false, events: [], deliveryCount: 0 };
  }

  const doEnqueue = deps.enqueueDelivery ?? defaultEnqueueDelivery;
  for (const evt of outcome.events) {
    if (evt.type === "raised" && notify) {
      try {
        await doEnqueue({ eventId: evt.id, eventAt: evt.at });
      } catch (err) {
        deps.logger?.error("enqueue delivery failed", { eventId: evt.id, error: err });
      }
    }
  }

  return {
    applied: true,
    alert: outcome.alert,
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(unavailableCode ? { unavailableCode } : {}),
    events,
    deliveryCount: outcome.deliveries.length,
  };
}

export function releaseLeaseToNextCadence(
  alert: Alert & { evaluationLeaseId: string },
  deps: Pick<EvaluateAlertDeps, "db" | "windowSec">
): Promise<boolean> {
  const cadenceSec = resolveAlertCapability(alert)?.capability.minCadenceSec ?? 300;
  return releaseLeaseForRetry(deps.db, {
    alertId: alert.id,
    leaseId: alert.evaluationLeaseId,
    nextEvaluationAt: scheduleNext(
      alert,
      cadenceSec,
      new Date(),
      deps.windowSec ?? DEFAULT_DISTRIBUTION_WINDOW_SEC
    ),
  });
}

function scheduleNext(alert: Alert, cadenceSec: number, now: Date, windowSec: number): Date {
  return computeNextEvaluationAt({
    previousDueAt: alert.nextEvaluationAt ?? now,
    cadenceSec: capCadenceSec(cadenceSec, env.ALERT_EVALUATION_CADENCE_CAP_SEC),
    now,
    alertId: alert.id,
    windowSec,
  });
}

const BATCH_ROWS = 10;
const BATCH_EXTRA_COLUMNS = 3;
const BATCH_VALUE_CHARS = 200;

function batchValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, BATCH_VALUE_CHARS);
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value).slice(0, BATCH_VALUE_CHARS);
  }
  return value;
}

function occurrenceBatch(
  occurrences: Extract<EvaluationResult, { kind: "occurrence" }>["occurrences"],
  capability: AlertCapability
) {
  const rowKey = capability.binding.rowKey ?? [];
  const skip = new Set([...rowKey, capability.binding.rowTimeColumn]);
  const rows = [...occurrences]
    .sort((a, b) => a.rowTime.getTime() - b.rowTime.getTime())
    .slice(0, BATCH_ROWS)
    .map((o) => ({
      id: rowKey.length ? rowKey.map((col) => String(o.facts[col])).join(":") : o.sourceEventId,
      time: o.rowTime.toISOString(),
      columns: Object.fromEntries(
        Object.entries(o.facts)
          .filter(([col]) => !skip.has(col))
          .slice(0, BATCH_EXTRA_COLUMNS)
          .map(([col, value]) => [col, batchValue(value)])
      ),
    }));
  return {
    rows,
    total: occurrences.length,
    overflow: Math.max(0, occurrences.length - BATCH_ROWS),
  };
}

function buildOutcomeEvents(
  events: AlertEventType[],
  result: EvaluationResult,
  now: Date,
  capability: AlertCapability
): Array<{
  type: AlertEventType;
  at: Date;
  facts: Record<string, unknown>;
  sourceEventId?: string;
}> {
  if (result.kind === "stateful") {
    return events.map((type) => ({ type, at: now, facts: result.facts }));
  }

  const occ = result.occurrences.reduce<(typeof result.occurrences)[number] | undefined>(
    (latest, o) => (!latest || o.rowTime > latest.rowTime ? o : latest),
    undefined
  );
  const facts = occ ? (occ.facts as Record<string, unknown>) : result.facts;
  const batch =
    capability.binding.source === "custom"
      ? { batch: occurrenceBatch(result.occurrences, capability) }
      : {};
  return events.map((type) => {
    return {
      type,
      at: now,
      facts: { ...facts, ...batch },
      sourceEventId: occ?.sourceEventId,
    };
  });
}
