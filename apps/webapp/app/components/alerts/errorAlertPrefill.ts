import type { AlertDraftPrefillParams } from "~/utils/pathBuilder";

export const NEW_ERROR_ALERT_PREFILL: AlertDraftPrefillParams = {
  capability: "errors.new",
  scope: "all",
};

export function errorGroupAlertPrefill(
  taskIdentifier: string,
  fingerprint: string
): AlertDraftPrefillParams {
  return {
    capability: "errors.occurred_again",
    scope: { type: "errorGroup", taskIdentifier, fingerprint },
  };
}
