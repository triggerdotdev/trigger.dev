import { json } from "@remix-run/server-runtime";
import { WaitpointKeyTransactionBudgetExhaustedError } from "@internal/run-store";
import { logger } from "~/services/logger.server";

/**
 * Keyed waitpoint creation ran out of its time budget under load. That is transient, not a
 * server fault, and the idempotency key makes a retry return the same waitpoint.
 * The one place this outcome is logged, at warn, so it stays visible without reaching Sentry.
 */
export function keyedWaitpointBudgetResponse(
  error: unknown,
  context: Record<string, unknown>
): Response | undefined {
  if (!(error instanceof WaitpointKeyTransactionBudgetExhaustedError)) return undefined;
  logger.warn("Keyed waitpoint creation over budget", context);
  return json(
    { error: "Waitpoint creation is busy, please retry" },
    { status: 503, headers: { "x-should-retry": "true" } }
  );
}
