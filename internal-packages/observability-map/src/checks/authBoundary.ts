import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { isTrivial } from "../triviality.js";
import { usesBuilder } from "./errorClassification.js";

const ID = "auth-boundary";

/**
 * What a guard looks like from the body. All three are matched against `calleeNames`, which is
 * scoped to the loader/action bodies and follows one hop into a same-file helper, so a guard the
 * route only imports and never calls does not count.
 */
const GUARDS = [
  /** `requireUserId`, `requireAdminApiRequest`, `authenticateApiRequest`. */
  /^(require|authenticate)/,
  /**
   * Proof of possession. A callback URL carrying an HMAC is authenticated by checking that HMAC:
   * `verifyHttpCallbackHash`, `verifyWebhookSignature`. Narrowed to the signature words so that an
   * unrelated `verifyEmail` does not read as an auth boundary.
   */
  /^verify.*(Hash|Hmac|Signature|Webhook|Callback|Token)/,
  /** `resolveAuthenticatedEnv`: the name says the identity was established. */
  /Authenticated/,
];

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
    if (ep.calleeNames.some((n) => GUARDS.some((g) => g.test(n)))) {
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
