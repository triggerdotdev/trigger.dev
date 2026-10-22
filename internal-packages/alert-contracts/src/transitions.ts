import type {
  AlertAttention,
  AlertEventType,
  AlertLifecycle,
  Behavior,
  EvaluationResult,
  ObservedCondition,
} from "./schemas.js";

export type DisplayStatus =
  | { status: "needs_attention" }
  | { status: "active" }
  | { status: "inactive"; reason: "completed" | "expired" | "stopped" };

export function displayStatus(lifecycle: AlertLifecycle, attention: AlertAttention): DisplayStatus {
  if (attention === "needs_attention") {
    return { status: "needs_attention" };
  }
  if (lifecycle === "active") {
    return { status: "active" };
  }
  const reason =
    lifecycle === "completed" ? "completed" : lifecycle === "expired" ? "expired" : "stopped";
  return { status: "inactive", reason };
}

export type AlertState = {
  lifecycle: AlertLifecycle;
  attention: AlertAttention;
  observedCondition: ObservedCondition;
  pendingMetSince: Date | null;
};

export type TransitionInput = {
  result: EvaluationResult;
  now: Date;
  holdSec: number;
  behavior: Behavior;
};

export type TransitionOutput = {
  next: AlertState;
  events: AlertEventType[];
  notify?: boolean;
  unseenOccurrences?: number;
  latestOccurrenceAt?: Date | null;
};

export function transition(prev: AlertState, input: TransitionInput): TransitionOutput {
  const { result, now, holdSec, behavior } = input;

  if (result.kind === "occurrence") {
    return transitionOccurrence(prev, input);
  }

  return transitionStateful(prev, result.outcome, now, holdSec, behavior, prev.lifecycle);
}

function transitionStateful(
  prev: AlertState,
  rawOutcome: "met" | "not_met" | "impossible" | "unavailable",
  now: Date,
  holdSec: number,
  behavior: Behavior,
  lifecycle: AlertLifecycle
): TransitionOutput {
  if (lifecycle !== "active") {
    return { next: { ...prev }, events: [] };
  }

  if (rawOutcome === "impossible") {
    return { next: { ...prev, observedCondition: "not_met", pendingMetSince: null }, events: [] };
  }

  if (rawOutcome === "unavailable") {
    return { next: { ...prev, pendingMetSince: null }, events: [] };
  }

  const resolvedOutcome = resolveHold(rawOutcome, prev, now, holdSec);

  if (resolvedOutcome === "pending") {
    return {
      next: {
        ...prev,
        pendingMetSince: prev.pendingMetSince ?? now,
      },
      events: [],
    };
  }

  if (resolvedOutcome === "cleared") {
    return {
      next: { ...prev, pendingMetSince: null },
      events: [],
    };
  }

  const prevObs = prev.observedCondition;
  const events: AlertEventType[] = [];

  if (resolvedOutcome === "met") {
    const notify = prev.attention === "clear";
    if (prevObs !== "met" || notify) {
      events.push("raised");
    }
    return {
      next: {
        lifecycle,
        attention: "needs_attention",
        observedCondition: "met",
        pendingMetSince: null,
      },
      events,
      notify,
    };
  }

  if (prevObs === "met") {
    events.push("recovered");
    return {
      next: {
        lifecycle,
        attention: prev.attention,
        observedCondition: "not_met",
        pendingMetSince: null,
      },
      events,
    };
  }

  return { next: { ...prev, observedCondition: "not_met", pendingMetSince: null }, events: [] };
}

type HoldResult = "met" | "not_met" | "pending" | "cleared";

function resolveHold(
  rawOutcome: "met" | "not_met",
  prev: AlertState,
  now: Date,
  holdSec: number
): HoldResult {
  if (holdSec <= 0) {
    return rawOutcome;
  }

  if (rawOutcome === "met") {
    if (prev.pendingMetSince === null) {
      return "pending";
    }
    const elapsed = (now.getTime() - prev.pendingMetSince.getTime()) / 1000;
    return elapsed >= holdSec ? "met" : "pending";
  }

  if (prev.pendingMetSince !== null) {
    return "cleared";
  }
  return "not_met";
}

function transitionOccurrence(prev: AlertState, input: TransitionInput): TransitionOutput {
  const { result } = input;
  if (result.kind !== "occurrence") {
    return { next: { ...prev }, events: [] };
  }

  const unseenOccurrences = result.occurrences.length;
  const latestOccurrenceAt = result.occurrences.reduce<Date | null>(
    (latest, o) => (latest === null || o.rowTime > latest ? o.rowTime : latest),
    null
  );
  const counts = { unseenOccurrences, latestOccurrenceAt };

  if (prev.lifecycle !== "active" || unseenOccurrences === 0 || prev.attention !== "clear") {
    return { next: { ...prev }, events: [], ...counts };
  }

  return {
    next: {
      lifecycle: prev.lifecycle,
      attention: "needs_attention",
      // observedCondition is informational-only for occurrence kinds and never
      // drives their transitions (REQ 023) -- stays "unknown".
      observedCondition: prev.observedCondition,
      pendingMetSince: null,
    },
    events: ["raised"],
    notify: true,
    ...counts,
  };
}

export function resolve(prev: AlertState): { next: AlertState; events: AlertEventType[] } {
  const events: AlertEventType[] = ["resolved"];
  return {
    next: {
      lifecycle: prev.lifecycle,
      attention: "clear",
      observedCondition: prev.observedCondition,
      pendingMetSince: prev.pendingMetSince,
    },
    events,
  };
}

export function expire(prev: AlertState): { next: AlertState; events: AlertEventType[] } {
  return {
    next: {
      lifecycle: "expired",
      attention: "clear",
      observedCondition: prev.observedCondition,
      pendingMetSince: prev.pendingMetSince,
    },
    events: ["expired"],
  };
}

export function stop(prev: AlertState): { next: AlertState; events: AlertEventType[] } {
  return {
    next: {
      lifecycle: "stopped",
      attention: prev.attention,
      observedCondition: prev.observedCondition,
      pendingMetSince: prev.pendingMetSince,
    },
    events: ["stopped"],
  };
}
