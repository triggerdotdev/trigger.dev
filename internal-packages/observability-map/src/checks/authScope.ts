import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { routeExports } from "../routeExports.js";
import { BUILDERS } from "./errorClassification.js";

const ID = "auth-scope";

type BuilderExport = { name: string; callee: string; scoped: boolean; why: string };

/**
 * The builder-wrapped exports of an entry point, each with its own verdict. Per export because the
 * exposure is per export: `authorization` is declared on the builder call one export made, and a
 * caller filter is written in the handler one export runs.
 */
function builderExports(ep: EntryPoint): BuilderExport[] {
  return routeExports(ep)
    .filter((e) => e.initializerCallee !== null && BUILDERS.has(e.initializerCallee))
    .map((e) => {
      const authorization = e.builderOptions.includes("authorization");
      return {
        name: e.name,
        callee: e.initializerCallee!,
        scoped: authorization || e.scopesByCaller,
        why: authorization ? "an authorization gate" : "a filter on the caller's identity",
      };
    });
}

/**
 * Whether a route the builder authenticated is also narrowed to the caller. The IDOR class it
 * measures: README, "The five checks". The two ways to be scoped, and why `ability.can(...)` is
 * deliberately not a third: INTERNALS.md, "What auth-scope reads as scoping".
 *
 * There is no triviality test here because `isTrivial` answers false for any route with an
 * initializer callee, and no delegating test because `scoreEntry` answers for every check before any
 * of them runs. One WAS here saying otherwise.
 *
 * Three residuals, running both ways. Accusing: `scopesByCallerIn` reads property assignments in that
 * export's own handlers only, so a handler pulling the id into a local first
 * (`const userId = user.id; ... { userId }`) is not seen. Crediting: a caller id passed as an ACTOR
 * argument rather than as a filter still counts, e.g. `generatePortalLink({ organizationId, userId })`
 * records who asked without constraining which org is read. Crediting: a helper running the membership
 * query for you is credited through the caller id handed to it, which is the same syntax; the four
 * helpers this applies to were hand-read and are correct.
 */
export const authScope = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (!classifySensitivity(ep).sensitive) {
      return { id: ID, status: "not-applicable", detail: "not sensitive" };
    }
    const builders = builderExports(ep);
    if (builders.length === 0) {
      return { id: ID, status: "not-applicable", detail: "no route builder to read options from" };
    }
    const unscoped = builders.filter((b) => !b.scoped);
    if (unscoped.length === 0) {
      const how = [...new Set(builders.map((b) => b.why))].join(" and ");
      return { id: ID, status: "pass", detail: `every builder-wrapped export has ${how}` };
    }
    const which = unscoped.map((b) => `${b.name} (${b.callee})`).join(", ");
    return {
      id: ID,
      status: "fail",
      detail: `authenticated but not scoped to the caller: ${which} declares no authorization gate and does not filter by the caller's identity`,
    };
  },
};
