import type { SubmitWatchErrorCode } from "./dashboardAgentWatches.server";

/**
 * One HTTP status per watch error code, so the resources route and the API route can't
 * drift on what a refusal means.
 */
const STATUS_BY_CODE: Record<SubmitWatchErrorCode, number> = {
  limit_reached: 409,
  watch_limit_reached: 409,
  duplicate: 409,
  request_conflict: 409,
  invalid_target: 404,
  chat_not_found: 404,
  not_configured: 501,
  internal: 500,
};

export function watchErrorStatus(code: SubmitWatchErrorCode): number {
  return STATUS_BY_CODE[code];
}
