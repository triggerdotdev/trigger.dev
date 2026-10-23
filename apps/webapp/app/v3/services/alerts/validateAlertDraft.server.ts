import {
  isScopeAllowed,
  type AlertCapability,
  type AlertKind,
  type AlertScopeType,
  type AlertSurface,
} from "@internal/alert-contracts";

type AlertDraftErrorReason =
  | "unknown_capability"
  | "surface"
  | "condition_kind"
  | "scope"
  | "absence_window";

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

export function validateAlertDraft(params: {
  capability: AlertCapability | undefined;
  capabilityKey: string;
  surface: AlertSurface;
  conditionKind: string;
  quietWindowSec?: number;
  scope: { type?: string } | undefined;
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
