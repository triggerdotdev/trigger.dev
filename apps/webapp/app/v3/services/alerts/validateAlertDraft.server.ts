import {
  isScopeAllowed,
  type AlertCapability,
  type AlertKind,
  type AlertScopeType,
  type AlertSurface,
} from "@internal/alert-contracts";

type AlertDraftErrorReason = "unknown_capability" | "surface" | "condition_kind" | "scope";

export interface AlertDraftError {
  reason: AlertDraftErrorReason;
  message: string;
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
  scope: { type?: string } | undefined;
}): AlertDraftError | null {
  const { capability } = params;

  if (!capability) {
    return { reason: "unknown_capability", message: `Unknown capability: ${params.capabilityKey}` };
  }

  if (!capability.surfaces.includes(params.surface)) {
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

  return null;
}
