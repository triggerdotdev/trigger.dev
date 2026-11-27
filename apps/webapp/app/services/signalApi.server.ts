import { json } from "@remix-run/server-runtime";
import { Ratelimit } from "@upstash/ratelimit";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { isS2Unavailable, SignalError } from "~/services/realtime/environmentSignals.server";
import { RateLimiter, type Duration } from "./rateLimiter.server";

/**
 * Per-environment limiter for signal sends and clears through the API (the platform's own sends
 * don't pass through it). On top of the general API limit: every send appends a record carrying
 * the whole latest map that each listening run of the environment receives, and concurrent sends
 * retry against each other, so signals are for changes of state, not a message stream.
 */
const signalSendRateLimiter = new RateLimiter({
  keyPrefix: "signal-send",
  limiter: Ratelimit.slidingWindow(120, "60 s" as Duration),
  logSuccess: false,
  logFailure: true,
});

/**
 * What the signal routes share: private credentials only (no public JWT), the per-environment
 * limit (sends and clears only), and a {@link SignalError}'s status. `doing` names the operation, as in
 * "Sending a signal".
 */
export async function signalApiResponse(
  authentication: { type: string; environment: AuthenticatedEnvironment },
  doing: string,
  signal: { name: string; task?: string },
  operation: (environment: AuthenticatedEnvironment) => Promise<object>,
  options?: { read?: boolean }
): Promise<Response> {
  if (authentication.type !== "PRIVATE") {
    return json({ error: `${doing} requires secret key authentication` }, { status: 403 });
  }
  // Reads append nothing, so only the general API limit applies to them.
  const limit = options?.read
    ? { success: true, reset: 0 }
    : await signalSendRateLimiter.limit(authentication.environment.id);
  if (!limit.success) {
    return json(
      { error: "Too many signal sends in this environment. Signals are for changes of state." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))),
        },
      }
    );
  }
  try {
    return json(await operation(authentication.environment));
  } catch (error) {
    if (error instanceof SignalError) {
      if (error.status === 503) {
        // Concurrent sends kept winning the append: retryable, so not an error per send.
        logger.warn(`${doing} failed: signals busy`, {
          environmentId: authentication.environment.id,
          signalName: signal.name,
          task: signal.task,
        });
        return json(
          { error: error.message },
          { status: error.status, headers: { "Retry-After": "1" } }
        );
      }
      return json({ error: error.message }, { status: error.status });
    }
    // Not `name`: the logger sets its own.
    const fields = {
      environmentId: authentication.environment.id,
      signalName: signal.name,
      task: signal.task,
      error,
    };
    if (isS2Unavailable(error)) {
      // Retryable, and one outage would otherwise be an error per send and per SDK retry.
      logger.warn(`${doing} failed: S2 unavailable`, fields);
      return json({ error: "Signals are unavailable. Try again shortly." }, { status: 503 });
    }
    logger.error(`${doing} failed`, fields);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
