import { logger } from "./logger.server";
import { ssoController } from "./sso.server";

// Shared auto-discovery check used by every login path that resolves a
// user identity before establishing a session: the magic-link send path
// (`/login/magic` action), the GitHub + Google OAuth callbacks, and the
// Vercel onboarding action. Each caller invokes this before committing
// the session; on `sso_required` they must short-circuit and redirect
// the user to the SSO flow instead.
//
// Fail-open: a plugin / DB error returns `null` so the original flow
// proceeds. The plugin logs the underlying reason; we additionally log
// here so the call site is obvious in traces.
export async function ssoRedirectForEmail(
  email: string,
  reason: "domain_policy" | "oauth_blocked"
): Promise<string | null> {
  const normalised = email.toLowerCase().trim();
  if (!normalised) return null;

  const decision = await ssoController.decideRouteForEmail(normalised);
  if (decision.isErr()) {
    logger.warn("SSO auto-discovery fail-open", { reason: decision.error, email: normalised });
    return null;
  }
  if (decision.value.kind !== "sso_required") return null;

  return `/login/sso?email=${encodeURIComponent(normalised)}&reason=${reason}`;
}

// Thrown from inside a strategy verify callback when the email's domain
// requires SSO. Must abort BEFORE any account write — blocking only the
// session would still leave the OAuth identity linked onto a user row
// that SSO enforcement was supposed to protect.
export class SsoRequiredError extends Error {
  constructor(public readonly redirectTo: string) {
    super(`sso_required:${redirectTo}`);
    this.name = "SsoRequiredError";
  }
}

// remix-auth wraps verify-callback throws in AuthorizationError (with
// the original error as `cause`); older strategy versions only preserve
// the message. Handle both.
export function ssoRedirectFromAuthError(thrown: unknown): string | null {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "cause" in thrown &&
    thrown.cause instanceof SsoRequiredError
  ) {
    return thrown.cause.redirectTo;
  }
  if (thrown instanceof SsoRequiredError) {
    return thrown.redirectTo;
  }
  if (thrown instanceof Error && thrown.message.startsWith("sso_required:")) {
    return thrown.message.slice("sso_required:".length);
  }
  return null;
}
