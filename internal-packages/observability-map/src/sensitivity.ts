import type { EntryPoint } from "./types.js";
import { routePathOf } from "./adapters/remix.js";

/**
 * Symbols whose presence says the route does something risky: minting or revoking a credential,
 * escalating to another user, destroying a tenant. Calling a guard is not one of them:
 * `requireAdminApiRequest` was on this list and made 34 of the 67 sensitive entry points sensitive
 * purely because they were guarded, which `auth-boundary` then passed them for. A mitigation
 * cannot be the hazard, and this list feeds the fix list's primary sort key.
 *
 * Half of this list used to name nothing. `Set.has` is exact, so `setImpersonation`, `createJWT`,
 * `signJWT` and `updateEnvVars`, none of which are exported anywhere in `apps/webapp/app`, matched
 * no route at all, while the real escalation `startImpersonation` was absent. Every name here now
 * resolves to a declaration in the webapp, and `test/webappSymbols.test.ts` fails if one stops
 * doing so.
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
  "createOrganizationAccessToken",
  "revokeOrganizationAccessToken",
  "createAuthorizationCode",
  "createApiKeyForEnv",
  "createPkApiKeyForEnv",
  "regenerateApiKey",
  "generateJWTTokenForEnvironment",
  "generateRegistryCredentials",
  "mintRunToken",
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
 * Segments in `SENSITIVE_SEGMENTS` that match no route in the tree today. Kept because they are
 * ordinary words for the thing they name, so a route called one of them would be sensitive the day
 * it lands, and separated because the rest of the vocabulary is read off the tree and
 * `test/webappSymbols.test.ts` holds it to that. Adding a word here is a deliberate statement that
 * it names nothing yet, and shows up in review as one.
 */
export const ANTICIPATED_SEGMENTS = ["payment", "invoices", "secrets"];

/**
 * Whole path segments only, so "authorship" does not match "auth".
 *
 * Every entry is a segment that exists in `apps/webapp/app/routes` today; the vocabulary was read
 * off the tree rather than invented, and `test/webappSymbols.test.ts` fails if a segment stops
 * appearing in a route name. Two consequences of that rule are worth stating rather than leaving
 * to be rediscovered: there is no `transfer` segment because the webapp has no org or project
 * transfer route, and org/project deletion is reached through `DeleteOrganizationService` above
 * rather than through a segment, because the four routes that delete are named `orgs` and
 * `projects` and `settings`.
 *
 * Two segments were measured and left out.
 *
 * `logout` is one route, and both questions the cohort exists to ask are meaningless on it:
 * `logout.tsx` destroys the caller's own session, so there is no other party's credential to guard
 * and no actor to record beyond the one already leaving. Including it produced one permanent
 * `auth-boundary` failure that no change to the route could clear.
 *
 * `sessions` is the bigger one. It reads as the auth session surface and is not: every `sessions`
 * route in this tree is the realtime agent-session product,
 * `_app...env.$envParam.sessions._index/route.tsx` renders `SessionsTable`, and
 * `api.v1.sessions.$session.close.ts` closes an agent session. Sixteen route files carry the
 * segment. The genuine session-management surface is `session-duration`, which is here, and the
 * credential minting inside those routes is caught by `mintSessionToken` in the symbol list above,
 * which is why `api.v1.sessions.ts` is in the cohort and its fifteen siblings are not.
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
 * A route-name segment with Remix's layout markers taken off, so the segment vocabulary can be
 * written the way a reader would say it. A trailing underscore opts a route out of its parent
 * layout (`resources.impersonation_.view-as.ts`) and changes nothing about what the route does.
 */
function normalizeSegment(segment: string): string {
  return segment.replace(/_+$/, "");
}

export type Sensitivity = { sensitive: boolean; reasons: string[] };

export function classifySensitivity(ep: EntryPoint): Sensitivity {
  const reasons: string[] = [];

  // importedNames is file-wide; calleeNames is scoped to the loader/action body. A sensitive
  // symbol called only at module scope is caught here only if it is also imported.
  const symbols = new Set([...ep.importedNames, ...ep.calleeNames]);
  for (const s of SENSITIVE_SYMBOLS) {
    if (symbols.has(s)) reasons.push(`calls ${s}`);
  }

  // `routePathOf` turns both flat routes (`api.v1.envvars.ts`) and directory routes
  // (`billing/route.tsx`) into real `/`-separated path segments, so this matches whole segments in
  // either shape rather than splitting the raw fileName on ".".
  const segments = routePathOf(ep.fileName)
    .split("/")
    .filter((s) => s.length > 0)
    .map(normalizeSegment);
  for (const [i, seg] of segments.entries()) {
    if (!SENSITIVE_SEGMENTS.includes(seg)) continue;
    // A waitpoint token is a handle for resuming a run, not a credential. Seven of the eight
    // `tokens` matches in the tree were waitpoint routes, so the segment on its own was mostly
    // finding the wrong thing.
    if ((seg === "token" || seg === "tokens") && segments[i - 1] === "waitpoints") continue;
    reasons.push(`path segment "${seg}"`);
  }

  return { sensitive: reasons.length > 0, reasons };
}
