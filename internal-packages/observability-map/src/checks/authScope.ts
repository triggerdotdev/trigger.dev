import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { BUILDERS } from "./errorClassification.js";

const ID = "auth-scope";

type BuilderExport = { name: string; callee: string; scoped: boolean; why: string };

/**
 * The builder-wrapped exports of an entry point, each with its own verdict.
 *
 * Per export, because the exposure is per export. `authorization` is declared on the builder call
 * one export made, and a caller filter is written in the handler one export runs, so neither says
 * anything about the other half of the file.
 */
function builderExports(ep: EntryPoint): BuilderExport[] {
  const all = [
    {
      name: "loader",
      callee: ep.loaderInitializerCallee,
      authorization: ep.loaderBuilderOptions.includes("authorization"),
      filters: ep.loaderScopesByCaller,
    },
    {
      name: "action",
      callee: ep.actionInitializerCallee,
      authorization: ep.actionBuilderOptions.includes("authorization"),
      filters: ep.actionScopesByCaller,
    },
  ];
  return all
    .filter((e) => e.callee !== null && BUILDERS.has(e.callee))
    .map((e) => ({
      name: e.name,
      callee: e.callee!,
      scoped: e.authorization || e.filters,
      why: e.authorization ? "an authorization gate" : "a filter on the caller's identity",
    }));
}

/**
 * Whether a route the builder authenticated is also narrowed to the caller.
 *
 * `auth-boundary` passes every builder-wrapped route, and that is correct as far as it goes: the
 * nine builders in `BUILDERS` all authenticate. What they do not all do is authorize.
 * `authorization` is an optional option and `apiBuilder.server.ts` runs the RBAC gate inside
 * `if (authorization)`, so a PAT route can be authenticated and completely unscoped. A PAT names
 * its target org or project by id or slug, and with no plugin installed the OSS fallback ability is
 * permissive, so nothing on that path stops a member of one org naming another org's project.
 * `apps/webapp/CLAUDE.md` states the rule this measures: "A PAT route must resolve its target
 * org/project scoped to the caller's membership. Skipping it opens cross-org access."
 *
 * Two ways for an export to be scoped, and EVERY builder-wrapped export has to be one of them:
 *
 * - its builder options declare `authorization:` with a real value, which is the RBAC gate, or
 * - its own handler filters by the caller's own id, the
 *   `members: { some: { userId: authentication.userId } }` shape in `api.v1.projects.ts` and the
 *   `presenter.call({ userId: user.id })` shape the dashboard routes use.
 *
 * `ability.can(...)` in the handler is deliberately NOT a third way, and it was one for part of
 * round C. `apps/webapp/CLAUDE.md` is explicit that it cannot be: the OSS fallback ability is
 * permissive (`internal-packages/rbac/src/fallback.ts` returns `permissiveAbility` for a PAT and
 * `buildFallbackAbility(user.admin)` for a session, neither of which reads org membership), so an
 * ability check enforces the ROLE and the membership-scoped query is the tenant floor. Crediting it
 * made this check agree with a route that resolves its target org from a URL slug and puts nothing
 * else in front of it.
 *
 * Applicable only where it is answerable: sensitive, builder-wrapped and not delegating. Outside
 * that it would be a second near-universal fail, which is the shape the `request-context` figure
 * already has and which the report has to collapse rather than list. There is no triviality test
 * here because there is nothing left for one to refuse: `isTrivial` answers false for any route
 * with an initializer callee, so a builder-wrapped route is never trivial.
 *
 * Three residuals, running in both directions.
 *
 * Accusing: `scopesByCallerIn` reads property assignments in that export's own handlers only. A
 * handler that pulls the id into a local first, `const userId = user.id; ... { userId }`, or that
 * builds its filter in a same-file helper, scopes itself and is not seen.
 *
 * Crediting: a caller id passed as an ACTOR argument rather than as a filter still counts.
 * `ssoController.generatePortalLink({ organizationId: orgId, userId: user.id })` records who asked;
 * it does not constrain which org is read. Telling the two apart means knowing what the callee does
 * with the argument, which for the dashboard means following it into a presenter. No route in the
 * tree is credited by this alone today.
 *
 * Crediting: a helper that runs the membership query for you is credited through the caller id
 * handed to it. `ApiKeysPresenter`, `TeamPresenter`, `regenerateApiKey` and
 * `DeleteOrganizationService` all do `members: { some: { userId } }` internally and throw when it
 * misses, which makes those four correct, and it is the same syntax as the actor-argument case
 * above. All were hand-read in round C.
 */
export const authScope = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (ep.delegating) {
      return { id: ID, status: "not-applicable", detail: "delegates its body to another module" };
    }
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
