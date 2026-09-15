import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { routeExports, type ExportName, type RouteExport } from "../routeExports.js";
import { isTrivialExport } from "../triviality.js";
import { BUILDERS } from "./errorClassification.js";

const ID = "auth-boundary";

/**
 * The guard helpers this webapp actually has, matched against the calling export's own callee names.
 * A guard the route only imports and never calls does not count, and neither does one the OTHER
 * export calls.
 *
 * Names rather than the three patterns it replaces, all of which over-matched: INTERNALS.md,
 * "Sensitivity, and the names the tool matches on". `webappSymbols.test.ts` fails if a name stops
 * resolving, but
 * cannot check that a declaration with the right name is the guard we meant, which is the residual
 * the two local helpers below carry.
 */
export const GUARDS = new Set([
  // Session and PAT identity, `apps/webapp/app/services/session.server.ts` and friends.
  "requireUser",
  "requireUserId",
  "requireOrganization",
  "requireAdminApiRequest",
  "authenticateApiRequest",
  "authenticateApiRequestWithFailure",
  "authenticateApiRequestWithPersonalAccessToken",
  "authenticateApiRequestWithOrganizationAccessToken",
  "authenticateApiKey",
  "authenticateAuthorizationHeader",
  "authenticateOrganizationAccessToken",
  "authenticatePersonalAccessToken",
  "authenticateRequest",
  "authenticateAdminRequest",
  "authenticatedEnvironmentForAuthentication",
  "authenticateAndAuthorize",
  // The RBAC controller, `packages/plugins/src/rbac.ts`, reached as `rbac.authenticateSession(...)`.
  // `calleeName` records the property for a member call, so these arrive here unqualified.
  "authenticateSession",
  "authenticatePat",
  "authenticateBearer",
  "authenticateUserActor",
  "authenticateAuthorizeSession",
  "authenticateAuthorizeBearer",
  // remix-auth, reached as `authenticator.authenticate(...)`. The login surface is sensitive and
  // cannot require an already authenticated caller, so establishing identity from the credential
  // presented is what a guard means there.
  "authenticate",
  "isAuthenticated",
  // Local helpers, each declared inside the one route that uses it.
  "authenticateAdmin",
  "authenticatePlainRequest",
  // Proof of possession: an HMAC on a callback URL, or a login-surface second factor. Same
  // reasoning as `authenticate` above for the two `login.mfa` names.
  "verifyHttpCallbackHash",
  "verifyWebhook",
  "verifyUserActorToken",
  "verifyTotpForLogin",
  "verifyRecoveryCodeForLogin",
]);

/**
 * Guards that answer with null instead of throwing, so calling one is not itself a boundary: these
 * are credited only when THAT EXPORT's handlers read what they returned
 * (`EntryPoint.loaderCheckedCallees`, which also carries the residual, that the test reading the
 * answer need not guard anything).
 */
export const SOFT_GUARDS = new Set(["getUser", "getUserId"]);

type GuardedExport = { name: ExportName; guarded: boolean; how: string; export: RouteExport };

/**
 * The exports this file declares, each with its own verdict. Per export because the exposure is per
 * export, and every input here used to be entry-point-wide, which is a false PASS on the one check
 * where that hides a security gap.
 *
 * `routeExports` lists only the exports the file declares, so an export that calls nothing at all is
 * judged rather than skipped: an empty body is exactly the unguarded case.
 */
function guardedExports(ep: EntryPoint): GuardedExport[] {
  return routeExports(ep).map((e) => {
    const verdict = (guarded: boolean, how: string) => ({ name: e.name, guarded, how, export: e });
    if (e.initializerCallee !== null && BUILDERS.has(e.initializerCallee)) {
      return verdict(true, "authenticated by the builder");
    }
    if (e.calleeNames.some((n) => GUARDS.has(n))) {
      return verdict(true, "guarded in the body");
    }
    if (e.checkedCallees.some((n) => SOFT_GUARDS.has(n))) {
      return verdict(true, "resolves the caller and reads the answer");
    }
    return verdict(false, "");
  });
}

/**
 * Whether a route that handles credentials, tokens or money checks who is asking.
 *
 * A fail here is an accusation, so it is only made when the body is the place a guard would have to
 * be. A trivial body cannot contain a visible privileged operation, so any guard is behind the same
 * import as the work and its absence proves nothing. That is the applicability rule in README, "When
 * a check declines to judge", and it is deliberately not the rule `request-context` uses.
 */
export const authBoundary = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    const sensitivity = classifySensitivity(ep);
    if (!sensitivity.sensitive) {
      return { id: ID, status: "not-applicable", detail: "not sensitive" };
    }
    // Never empty: `scanFile` returns null unless the file declares a loader or an action.
    const exports = guardedExports(ep);
    const guarded = exports.filter((e) => e.guarded);
    // Triviality excuses per export, matching the attribution: read entry-point-wide, a busy action
    // made a redirect-stub loader answerable for a guard it has nothing to guard.
    const accused = exports.filter((e) => !e.guarded && !isTrivialExport(e.export));
    if (accused.length > 0) {
      return {
        id: ID,
        status: "fail",
        detail: `sensitive (${sensitivity.reasons.join(", ")}) with no auth guard in the body: ${accused
          .map((e) => e.name)
          .join(", ")}`,
      };
    }
    if (guarded.length > 0) {
      const how = [...new Set(guarded.map((e) => e.how))].join(" and ");
      return { id: ID, status: "pass", detail: how };
    }
    return {
      id: ID,
      status: "not-applicable",
      detail: "cannot verify: no privileged work in the body, any guard is behind an import",
    };
  },
};
