/**
 * Client-safe auth-failure messages.
 *
 * Auth controllers (the OSS RBAC fallback and the cloud RBAC plugin) return
 * an `error` string on failure. That string is NOT safe to forward to the
 * client: a controller can conflate an infrastructure failure with an auth
 * rejection — e.g. when the database is unreachable the plugin's key lookup
 * throws a Prisma error ("Can't reach database server at <prod RDS
 * hostname>") which it returns as the auth `error`. The apiBuilder then put
 * that string into the response body, and the SDK surfaced it verbatim in
 * the customer's run view via `TriggerApiError`, leaking internal infra
 * detail.
 *
 * The client only ever needs to know *that* auth failed and *which kind*
 * (401 = who are you / 403 = not allowed) so its retry logic can branch.
 * It never needs the controller's prose. So we derive the message purely
 * from the status and drop the controller's string (logged server-side at
 * the call site). This makes leakage impossible regardless of what any
 * current or future controller returns — there is no path by which a raw
 * internal string reaches the client.
 */
export type AuthFailureStatus = 401 | 403;

export function publicAuthError(status: AuthFailureStatus): string {
  return status === 403 ? "Forbidden" : "Invalid credentials";
}

/**
 * Replace a controller auth failure's `error` with the status-derived
 * client-safe message, preserving the status. The original `error` is
 * intentionally discarded here — callers log it server-side before
 * sanitizing so full detail is retained in logs.
 */
export function sanitizeAuthFailure(failure: { status: AuthFailureStatus; error: string }): {
  status: AuthFailureStatus;
  error: string;
} {
  return { status: failure.status, error: publicAuthError(failure.status) };
}
