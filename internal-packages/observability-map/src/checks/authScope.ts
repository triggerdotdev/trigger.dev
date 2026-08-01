import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { BUILDERS } from "./errorClassification.js";

const ID = "auth-scope";

/** The builder-wrapped exports of an entry point, with the options each was given. */
function builderExports(ep: EntryPoint): { callee: string; options: string[] }[] {
  const all = [
    { callee: ep.loaderInitializerCallee, options: ep.loaderBuilderOptions },
    { callee: ep.actionInitializerCallee, options: ep.actionBuilderOptions },
  ];
  return all.filter(
    (e): e is { callee: string; options: string[] } => e.callee !== null && BUILDERS.has(e.callee)
  );
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
 * Three ways to be scoped, matching the three ways the tree does it:
 *
 * - the builder options declare `authorization:`, which is the RBAC gate, or
 * - the handler filters by the caller's own id, the
 *   `members: { some: { userId: authentication.userId } }` shape in `api.v1.projects.ts` and the
 *   `presenter.call({ userId: user.id })` shape the dashboard routes use, or
 * - the handler calls `ability.can(...)` itself, which is the same gate declared in the options
 *   moved into the body. Five dashboard routes do that deliberately, because which ability a
 *   request needs depends on the intent it carries.
 *
 * `authorization:` has to be declared on EVERY builder-wrapped export of the entry point, not one
 * of them. A file exporting a scoped loader beside an unscoped action is not a scoped route, and a
 * union would have said it was.
 *
 * Applicable only where it is answerable: sensitive, builder-wrapped and not delegating. Outside
 * that it would be a second near-universal fail, which is the shape the `request-context` figure
 * already has and which the report has to collapse rather than list. There is no triviality test
 * here because there is nothing left for one to refuse: `isTrivial` answers false for any route
 * with an initializer callee, so a builder-wrapped route is never trivial.
 *
 * Two residuals, both worth stating because they run in opposite directions.
 *
 * The accusing one: `scopesByCaller` reads property assignments only, so a handler that pulls the
 * id out first, `const { userId } = authentication; ... where: { userId }`, scopes itself and is
 * not seen. No route in the tree writes it that way.
 *
 * The crediting one: an ability gate is a ROLE gate, and `apps/webapp/CLAUDE.md` is explicit that
 * it is not the tenant floor, because the OSS fallback ability is permissive
 * (`internal-packages/rbac/src/fallback.ts` returns `permissiveAbility` for a PAT and
 * `buildFallbackAbility(user.admin)` for a session, neither of which reads org membership). So a
 * pass here means "the route gates on something", not "a non-member is rejected on self-hosted".
 * Reading the membership-scoped query directly would need to follow the query into the presenter
 * or model it calls, which is a different kind of analysis from anything else in this package.
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
    if (builders.every((b) => b.options.includes("authorization"))) {
      return { id: ID, status: "pass", detail: "the builder declares an authorization gate" };
    }
    if (ep.scopesByCaller) {
      return { id: ID, status: "pass", detail: "the handler filters by the caller's identity" };
    }
    if (ep.checksAbility) {
      return { id: ID, status: "pass", detail: "the handler runs the ability gate itself" };
    }
    const missing = builders
      .filter((b) => !b.options.includes("authorization"))
      .map((b) => b.callee)
      .join(", ");
    return {
      id: ID,
      status: "fail",
      detail: `authenticated but not scoped to the caller: ${missing} declares no authorization gate and the handler does not filter by the caller's identity`,
    };
  },
};
