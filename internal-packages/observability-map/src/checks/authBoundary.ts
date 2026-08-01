import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { isTrivial } from "../triviality.js";
import { usesBuilder } from "./errorClassification.js";

const ID = "auth-boundary";

/**
 * The guard helpers this webapp actually has, matched against `calleeNames`, which is scoped to the
 * loader/action bodies and follows one hop into a same-file helper. A guard the route only imports
 * and never calls does not count.
 *
 * A name list rather than the three patterns it replaces, because all three over-matched and this
 * is the one check where a false pass hides a security gap:
 *
 * - `/^(require|authenticate)/` passed any callee at all beginning `require`. Live in the tree:
 *   `requireSsoEntitlement`, a plan check, cleared `_app.orgs.$organizationSlug.settings.sso`. A
 *   local `requireValidParams(request)` would do the same for any route someone writes next.
 * - `/Authenticated/` passed `resolveAuthenticatedEnv`, used by ten routes, which is
 *   `findFirst({ where: { id: environmentId } })` in
 *   `internal-packages/run-engine/src/engine/controlPlaneResolver.ts`: it hydrates an environment
 *   record, it authenticates nothing. The docstring that put it here asserted the opposite. It also
 *   passed `commitAuthenticatedSession`, a cookie write, on six routes.
 * - `/^verify.*(Hash|Hmac|Signature|Webhook|Callback|Token)/` was sound on the tree, and is kept as
 *   three names for the same reason as the rest.
 *
 * Every name resolves to a declaration in the webapp or in the packages it authenticates through;
 * `test/webappSymbols.test.ts` fails if one stops doing so. What that test cannot check is that a
 * declaration with the right name is the guard we meant: `authenticateAdmin` and
 * `authenticatePlainRequest` are local helpers inside a single route file, so a second route
 * declaring its own no-op `authenticateAdmin` would be credited. That is a narrower hole than a
 * five-character prefix and it is the reason the list is names rather than patterns.
 */
export const GUARDS = new Set([
  // Session and PAT identity, `apps/webapp/app/services/session.server.ts` and friends.
  "requireUser",
  "requireUserId",
  // The non-throwing variants. They resolve the caller from the session cookie and hand back null
  // rather than redirecting, so the route decides what to do with the answer:
  // `invite-accept.tsx` refuses an invite addressed to a different email, `login._index` sends an
  // already-authenticated caller away. Crediting them is a weaker claim than crediting
  // `requireUserId`, and the residual is a route that calls one and ignores what it said. Both
  // routes in the sensitive cohort that call one act on it; that was hand-read, not assumed.
  "getUser",
  "getUserId",
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
  // remix-auth, reached as `authenticator.authenticate(...)` / `authenticator.isAuthenticated(...)`.
  // The login surface is sensitive under `sensitivity.ts` and cannot require an already
  // authenticated caller, so establishing identity from the credential presented is what a guard
  // means there.
  "authenticate",
  "isAuthenticated",
  // Local helpers, each declared inside the one route that uses it.
  "authenticateAdmin",
  "authenticatePlainRequest",
  // Proof of possession: a callback URL carrying an HMAC is authenticated by checking that HMAC.
  "verifyHttpCallbackHash",
  "verifyWebhook",
  "verifyUserActorToken",
]);

/**
 * Whether a route that handles credentials, tokens or money checks who is asking.
 *
 * A fail here is an accusation, and it is only supportable when the body is the place a guard
 * would have to be. That holds when the route does its privileged work in the open: reads the
 * request, queries the datastore, mints the token. It does not hold for a trivial body, so those
 * are reported not-applicable rather than failed.
 *
 * The reasoning is the triviality rule's own definition rather than a convenience. A trivial body
 * has three statements or fewer, three calls or fewer, no try/catch, no builder, and no mention of
 * prisma, redis, fetch or the engine anywhere in its source. It therefore cannot contain a visible
 * privileged operation. Either it does nothing privileged at all, like the `/orgs/:slug/billing`
 * redirect stub, or the privileged work sits behind an import, like `clearImpersonation`, which
 * authenticates and writes an audit row in `app/models/admin.server.ts`. In the second case the
 * guard is in the same unopened file as the work. Absence of evidence, and reporting it as a
 * finding puts a wrong answer at the top of the fix list.
 *
 * This is not the rule `request-context` uses, deliberately. There the thing being looked for, a
 * field on a log call inside a catch, would be in the body if it existed at all, because the catch
 * is in the body. Absence of a log is evidence. Here the thing being looked for guards work that
 * is not in the body either, so its absence proves nothing. The test that separates them: would
 * this evidence necessarily be visible in the body if it existed?
 *
 * The design also matched `importedNames`. Across the 67 sensitive entry points that widening
 * changes nothing, every route with a `require*` import calls it from the body too, so the
 * file-wide half only ever stood to hand out a pass for a dead import. It is gone.
 */
export const authBoundary = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    const sensitivity = classifySensitivity(ep);
    if (!sensitivity.sensitive) {
      return { id: ID, status: "not-applicable", detail: "not sensitive" };
    }
    if (usesBuilder(ep)) {
      return { id: ID, status: "pass", detail: "authenticated by the builder" };
    }
    if (ep.calleeNames.some((n) => GUARDS.has(n))) {
      return { id: ID, status: "pass", detail: "guarded in the body" };
    }
    if (isTrivial(ep)) {
      return {
        id: ID,
        status: "not-applicable",
        detail: "cannot verify: no privileged work in the body, any guard is behind an import",
      };
    }
    return {
      id: ID,
      status: "fail",
      detail: `sensitive (${sensitivity.reasons.join(", ")}) with no auth guard in the body`,
    };
  },
};
