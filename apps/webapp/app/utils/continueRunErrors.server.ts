import { json } from "@remix-run/server-runtime";
import { LockAcquisitionTimeoutError } from "@internal/run-engine";
import { isPrismaRetriableError } from "@trigger.dev/database";
import { clientSafeErrorMessage, isInfrastructureError } from "./prismaErrors";

/**
 * The response the worker `continue` route sends for an error thrown while continuing a run, or
 * undefined to let the error reach the generic 500 handler, which scrubs the message.
 *
 * With `retryableErrors` on, a temporary database error (unreachable, pool or transaction-start
 * timeout, write conflict) gets 503 and a busy run lock gets 409. The supervisor keeps retrying both
 * for its full budget, so a run restored during a brief database outage resumes instead of being
 * aborted. A plain 500 then only comes from outside this handler (authentication, parameter
 * parsing), and the supervisor retries it briefly; an unexpected error inside it is a 422, as
 * before.
 *
 * With it off, the responses are unchanged: infrastructure errors 500, everything else 422.
 */
export function continueRunErrorResponse(
  error: unknown,
  { retryableErrors }: { retryableErrors: boolean }
): Response | undefined {
  if (retryableErrors) {
    // This sends pool exhaustion (P2024) and a Rust-engine panic to 503, although
    // `isRetryableInfrastructureError` in the database package never retries either. That gate
    // decides an immediate retry in the same process, where another attempt competes for the same
    // exhausted pool or the same broken engine. Here the alternative is aborting the run, and the
    // retry is a separate request from the supervisor, seconds apart with jitter, bounded by its
    // budget, and possibly served by another instance.
    if (isInfrastructureError(error) || isPrismaRetriableError(error)) {
      return json({ error: "Temporarily unable to continue run execution" }, { status: 503 });
    }

    if (error instanceof LockAcquisitionTimeoutError) {
      return json({ error: "Run is busy, try again" }, { status: 409 });
    }
  } else if (isInfrastructureError(error)) {
    return undefined;
  }

  return json(
    {
      error:
        error instanceof Error ? clientSafeErrorMessage(error) : "Failed to continue run execution",
    },
    { status: 422 }
  );
}
