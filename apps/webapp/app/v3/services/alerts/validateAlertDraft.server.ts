import {
  getCapability,
  isScopeAllowed,
  type AlertCapability,
  type AlertKind,
  type AlertScopeType,
  type AlertSurface,
  type LimitSignal,
} from "@internal/alert-contracts";

type AlertDraftErrorReason =
  | "unknown_capability"
  | "surface"
  | "condition_kind"
  | "scope"
  | "absence_window"
  | "components"
  | "signals";

export interface AlertDraftError {
  reason: AlertDraftErrorReason;
  message: string;
}

const DEFAULT_MIN_ABSENCE_WINDOW_SEC = 1800;

/** Undefined for query alerts: their floor is the source cadence, checked when the query is analyzed. */
export function absenceWindowFloor(capability: AlertCapability): number | undefined {
  if (capability.key === "custom.query") return undefined;
  return capability.minWindowSec ?? DEFAULT_MIN_ABSENCE_WINDOW_SEC;
}

export function absenceWindowMessage(minWindowSec: number): string {
  return `Quiet window must be at least ${minWindowSec} seconds`;
}

function validateScope(
  capability: AlertCapability,
  scope: { type?: string } | undefined
): string | null {
  const scopeType = (scope?.type ?? "all") as AlertScopeType;

  if (isScopeAllowed(capability, scopeType)) return null;

  return `capability ${capability.key} does not allow scope type ${scopeType}`;
}

function allowedSignals(
  capability: AlertCapability,
  components?: string[]
): LimitSignal[] | undefined {
  if (capability.supportedSignals) return capability.supportedSignals;
  const parts = components ?? capability.binding.compositeOf;
  if (!capability.binding.compositeOf || !parts) return undefined;
  const union = new Set<LimitSignal>();
  for (const key of parts) {
    for (const signal of getCapability(key)?.supportedSignals ?? []) union.add(signal);
  }
  return union.size ? [...union] : undefined;
}

function validateLimitFields(
  capability: AlertCapability,
  fields: { compositeMode?: string; signals?: string[]; components?: string[] }
): AlertDraftError | null {
  const compositeOf = capability.binding.compositeOf;
  if (fields.compositeMode !== undefined && !compositeOf) {
    return {
      reason: "components",
      message: `capability ${capability.key} does not support compositeMode`,
    };
  }
  if (fields.components !== undefined) {
    if (!compositeOf) {
      return {
        reason: "components",
        message: `capability ${capability.key} does not support components`,
      };
    }
    const unknown = fields.components.filter((c) => !compositeOf.includes(c));
    if (unknown.length > 0 || fields.components.length === 0) {
      return {
        reason: "components",
        message: unknown.length
          ? `components not part of ${capability.key}: ${unknown.join(", ")}`
          : "Pick at least one component",
      };
    }
  }
  if (fields.signals !== undefined) {
    const allowed = allowedSignals(capability, fields.components);
    if (!allowed) {
      return {
        reason: "signals",
        message: `capability ${capability.key} does not support signals`,
      };
    }
    const unsupported = fields.signals.filter((s) => !allowed.includes(s as LimitSignal));
    if (unsupported.length > 0 || fields.signals.length === 0) {
      return {
        reason: "signals",
        message: unsupported.length
          ? `signals not supported by ${capability.key}: ${unsupported.join(", ")}`
          : "Pick at least one signal",
      };
    }
    const unwatched = (compositeOf ? (fields.components ?? compositeOf) : []).filter(
      (key) => !getCapability(key)?.supportedSignals?.some((s) => fields.signals!.includes(s))
    );
    if (unwatched.length > 0) {
      return {
        reason: "signals",
        message: `selected signals not supported by: ${unwatched.join(", ")}`,
      };
    }
  }
  return null;
}

export function validateAlertDraft(params: {
  capability: AlertCapability | undefined;
  capabilityKey: string;
  surface: AlertSurface;
  conditionKind: string;
  quietWindowSec?: number;
  scope: { type?: string } | undefined;
  compositeMode?: string;
  signals?: string[];
  components?: string[];
}): AlertDraftError | null {
  const { capability } = params;

  if (!capability) {
    return { reason: "unknown_capability", message: `Unknown capability: ${params.capabilityKey}` };
  }

  const isQueryAlert =
    capability.key === "custom.query" &&
    (params.surface === "alerts_page" || params.surface === "mcp" || params.surface === "agent");
  if (!isQueryAlert && !capability.surfaces.includes(params.surface)) {
    return {
      reason: "surface",
      message: `capability ${capability.key} is not available on this surface`,
    };
  }

  if (!capability.allowedKinds.includes(params.conditionKind as AlertKind)) {
    return {
      reason: "condition_kind",
      message: `capability ${capability.key} does not allow condition kind ${params.conditionKind}`,
    };
  }

  const scopeError = validateScope(capability, params.scope);
  if (scopeError) {
    return { reason: "scope", message: scopeError };
  }

  const limitError = validateLimitFields(capability, params);
  if (limitError) return limitError;

  const minWindowSec = absenceWindowFloor(capability);
  if (
    params.conditionKind === "absence" &&
    minWindowSec !== undefined &&
    params.quietWindowSec !== undefined &&
    params.quietWindowSec < minWindowSec
  ) {
    return { reason: "absence_window", message: absenceWindowMessage(minWindowSec) };
  }

  return null;
}

export function stateFields(condition: {
  kind: string;
  compositeMode?: string;
  signals?: string[];
  components?: string[];
}) {
  if (condition.kind !== "state") return {};
  const { compositeMode, signals, components } = condition;
  return { compositeMode, signals, components };
}
