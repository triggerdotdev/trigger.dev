import { EnvironmentPauseSource } from "@trigger.dev/database";
import type { PauseStatus } from "~/v3/services/pauseEnvironment.server";

/**
 * Guards manual pause/resume API calls while an environment is billing-paused.
 *
 * Design trade-off: billing-limit converge unpauses every environment with
 * `pauseSource=BILLING_LIMIT` on resolve. We therefore do not record a
 * separate manual pause on top of billing enforcement — a manual pause attempt
 * while already billing-paused is a silent no-op (`success: true`, still
 * paused). If the limit is later resolved, that environment is unpaused with
 * the rest, even if the caller intended to keep it paused.
 *
 * The queues UI hides pause/resume while `pauseSource=BILLING_LIMIT`; API
 * callers can still hit this path and should treat the no-op as idempotent.
 */
export function getManualPauseEnvironmentResult(
  action: PauseStatus,
  pauseSource: EnvironmentPauseSource | null | undefined
):
  | { proceed: true }
  | { proceed: false; success: true; state: PauseStatus }
  | { proceed: false; success: false; error: string } {
  if (action === "resumed" && pauseSource === EnvironmentPauseSource.BILLING_LIMIT) {
    return {
      proceed: false,
      success: false,
      error:
        "This environment is paused because your organization reached its billing limit. Resolve the limit on the billing limits settings page to resume.",
    };
  }

  if (action === "paused" && pauseSource === EnvironmentPauseSource.BILLING_LIMIT) {
    // Already billing-paused; do not overwrite pauseSource so resolve converge
    // can still find and unpause this environment.
    return {
      proceed: false,
      success: true,
      state: "paused",
    };
  }

  return { proceed: true };
}
