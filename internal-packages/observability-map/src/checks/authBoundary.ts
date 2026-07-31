import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { usesBuilder } from "./errorClassification.js";

const ID = "auth-boundary";

/**
 * The two shapes the webapp's guards take: `requireUserId`, `requireAdminApiRequest`,
 * `authenticateApiRequest`, `authenticateProjectApiKey`. Matched against `calleeNames`, which is
 * scoped to the loader/action bodies and follows one hop into a same-file helper, so a guard the
 * route only imports and never calls does not count.
 */
const GUARD = /^(require|authenticate)/;

/**
 * Whether a route that handles credentials, tokens or money checks who is asking.
 *
 * The design matched `importedNames` as well as `calleeNames`. Across the 67 sensitive entry points
 * in the real tree that widening changes nothing: every route with a `require*` import calls it
 * from the body too. So the file-wide half only ever stood to hand out a pass for a dead import,
 * and it is gone.
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
    if (ep.calleeNames.some((n) => GUARD.test(n))) {
      return { id: ID, status: "pass", detail: "guarded in the body" };
    }
    return {
      id: ID,
      status: "fail",
      detail: `sensitive (${sensitivity.reasons.join(", ")}) with no auth guard in the body`,
    };
  },
};
