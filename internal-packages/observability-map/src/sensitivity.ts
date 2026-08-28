import type { EntryPoint } from "./types.js";
import { routePathOf } from "./adapters/remix.js";

/**
 * Symbols whose presence says the route does something risky: minting or revoking a credential,
 * escalating to another user, destroying a tenant. Calling a guard is never one of them, because a
 * mitigation cannot be the hazard, and `webappSymbols.test.ts` fails if a name stops resolving in the
 * webapp. Both rules and what they cost: INTERNALS.md, "Sensitivity, and the names the tool
 * matches on".
 */
export const SENSITIVE_SYMBOLS = [
  // Escalation: acting as another user.
  "startImpersonation",
  "clearImpersonation",
  "generateImpersonationToken",
  // Minting and revoking credentials.
  "createPersonalAccessToken",
  "createPersonalAccessTokenFromAuthorizationCode",
  "revokePersonalAccessToken",
  "createAuthorizationCode",
  "createApiKeyForEnv",
  "createPkApiKeyForEnv",
  "regenerateApiKey",
  "generateJWTTokenForEnvironment",
  "generateRegistryCredentials",
  "mintSessionToken",
  "mintDashboardAgentToken",
  "mintDashboardAgentUserActorToken",
  // Access control and tenant destruction. `DeleteOrganizationService`/`DeleteProjectService` are
  // classes, reached through `importedNames`: four routes import one and none is named for it.
  "removeTeamMember",
  "revokeInvite",
  "DeleteOrganizationService",
  "DeleteProjectService",
];

/**
 * Segments in `SENSITIVE_SEGMENTS` that match no route in the tree today, kept apart because
 * `webappSymbols.test.ts` holds the rest of the vocabulary to naming something. Adding a word here is
 * a deliberate statement that it names nothing yet, and shows up in review as one.
 */
export const ANTICIPATED_SEGMENTS = ["payment", "invoices", "secrets"];

/**
 * Whole path segments only, so "authorship" does not match "auth". Every entry exists in
 * `apps/webapp/app/routes` today and `webappSymbols.test.ts` fails if one stops appearing.
 *
 * Two absences worth knowing rather than rediscovering. `logout` is left out because
 * `logout.tsx` destroys the caller's own session, so there is no other party's credential to guard and
 * no actor to record, and including it produced one permanent `auth-boundary` failure nothing could
 * clear. `sessions` is left out because every `sessions` route in this tree is the realtime
 * agent-session product rather than the auth surface, sixteen files of it; the genuine
 * session-management surface is `session-duration` below, and the credential minting inside those
 * routes is caught by `mintSessionToken` above.
 */
export const SENSITIVE_SEGMENTS = [
  // Credentials, tokens and money: the original vocabulary.
  "auth",
  "jwt",
  "token",
  "tokens",
  "envvars",
  "billing",
  ...ANTICIPATED_SEGMENTS,
  "impersonate",
  "authorization-code",
  "regenerate-api-key",
  // Access control: who is in a tenant and what they may do.
  "members",
  "invites",
  "invite",
  "invite-accept",
  "invite-resend",
  "invite-revoke",
  "roles",
  "team",
  // Authentication and session management. The login surface handles credentials even though it
  // is, by design, the one surface an unauthenticated caller may reach.
  "login",
  "magic",
  "mfa",
  "sso",
  "security",
  "session-duration",
  // Credentials again, in the spellings the tree actually uses.
  "apikeys",
  "revoked-api-keys",
  "impersonation",
  // The bare `billing` segment matches neither of these, and it matches no admin route at all.
  "billing-limit",
  "billing-limits",
  "billing-alerts",
];

/**
 * A route-name segment with Remix's layout markers taken off. A trailing underscore opts a route out
 * of its parent layout and changes nothing about what the route does.
 */
export function normalizeSegment(segment: string): string {
  // Trimmed by hand rather than with /_+$/, which backtracks polynomially and trips CodeQL. Nothing
  // here is attacker-controlled, so this is about not spending a reviewer's attention on the alert.
  let end = segment.length;
  while (end > 0 && segment[end - 1] === "_") end--;
  return segment.slice(0, end);
}

export type Sensitivity = { sensitive: boolean; reasons: string[] };

export function classifySensitivity(ep: EntryPoint): Sensitivity {
  const reasons: string[] = [];

  // `importedNames` is file-wide and `calleeNames` is body-scoped, so a sensitive symbol called only
  // at module scope is caught here only if it is also imported.
  const symbols = new Set([...ep.importedNames, ...ep.calleeNames]);
  for (const s of SENSITIVE_SYMBOLS) {
    if (symbols.has(s)) reasons.push(`calls ${s}`);
  }

  // `routePathOf` normalises both flat and directory routes to `/`-separated segments, so this
  // matches whole segments in either shape rather than splitting the raw fileName on ".".
  const segments = routePathOf(ep.fileName)
    .split("/")
    .filter((s) => s.length > 0)
    .map(normalizeSegment);
  for (const [i, seg] of segments.entries()) {
    if (!SENSITIVE_SEGMENTS.includes(seg)) continue;
    // A waitpoint token is a handle for resuming a run rather than a credential, and seven of the
    // eight `tokens` matches in the tree were waitpoint routes.
    if ((seg === "token" || seg === "tokens") && segments[i - 1] === "waitpoints") continue;
    reasons.push(`path segment "${seg}"`);
  }

  return { sensitive: reasons.length > 0, reasons };
}
