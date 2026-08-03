import type { RouteExport } from "./routeExports.js";
import type { EntryPoint } from "./types.js";

/**
 * Substrings that say the route touches a service, a datastore or the network. Always matched
 * against the callee names, and additionally against `TrivialityView.hintText`, which is the whole
 * file for the entry-point-wide view and empty for a per-export one.
 */
const SIDE_EFFECT_HINTS = ["prisma", "logger", "fetch", "$transaction", "redis", "engine"];

/**
 * Calls a genuinely trivial body makes: parse the params, build a path, hand back a response. Every
 * shape found in the real tree stays at or below three, so anything busier is doing work. Allowing
 * a fourth admits `_app.orgs.$organizationSlug.settings/route.tsx`, which awaits two service calls.
 */
const MAX_CALLS = 3;

/**
 * Parse the params, build a path, redirect. Or an environment guard and two returns. Both real
 * shapes need three. Allowing a fourth admits the routes that authenticate and then hand off to a
 * presenter (`...tasks.stream/route.tsx`), which have real work behind them and belong in the
 * report; allowing a fifth admits an admin route that calls a service and hand-rolls its own error
 * responses.
 */
const MAX_STATEMENTS = 3;

/**
 * What the rule reads, so the entry-point-wide answer and a single export's answer are the same
 * rule over different bodies rather than two rules that can drift.
 */
type TrivialityView = {
  statementCount: number;
  calleeNames: string[];
  hasTryCatch: boolean;
  /** Every builder call in scope of this view. A view with one is never trivial. */
  initializerCallees: (string | null)[];
  /**
   * Text to match the side-effect hints against besides the callee names.
   *
   * The whole file for the entry-point-wide view, so an import of `prisma` disqualifies it even
   * when the query sits somewhere the scanner does not walk. For a per-export view it is that
   * export's own callee PATHS instead, and the difference is not a convenience:
   *
   * - The file's text is a fact about the file, so reading it into one export's verdict is the
   *   per-file-for-per-export substitution this rule exists to damp. It is also defeatable.
   *   `log-caller-scope-userid` in the mutation corpus prepends `logger.error(...)` to every body;
   *   with this term file-wide that put the word `logger` in `auth.github.ts` and turned its
   *   untouched one-line redirect loader from excused into accused, on a rewrite that changed
   *   nothing the loader does.
   * - Emptying it instead is not the answer either, and that was measured: `calleeNames` keeps only
   *   a call's last segment, so `prisma.orgMember.findMany` reads as `findMany` and a
   *   three-statement body that queries the datastore matches no hint at all. Five existing
   *   `auth-boundary` fixtures went from `fail` to `not-applicable`, which is the check being
   *   switched off rather than fixed.
   *
   * The callee paths are body-scoped like the first option wants and name the receiver like the
   * second needs. Comments and imports are not in them, which is deliberate: everything in this
   * view is something the export actually does.
   */
  hintText: string;
};

/**
 * Nothing to instrument: a body of a statement or two that only redirects, returns a fixed
 * response, or hands off in a single call. Checks report not-applicable for these rather than
 * failing, which is what stops `@.ts` being a finding.
 *
 * Deliberately reluctant. A route wrongly called trivial is exempted and never shows up in the
 * report again, so every signal that the body might be doing real work rules triviality out:
 *
 * - `statementCount` counts a nested function's statements but `calleeNames` descends further, into
 *   the callee of every call at any depth, so the call count still catches bodies the statement
 *   count reads as short.
 * - An initializer callee means the route is wrapped in a builder, and the config passed to that
 *   builder (`findResource`, `authorization`) is work the scanner never walks. The visible body is
 *   not the whole route, so we cannot claim it is trivial.
 * - A try/catch is exactly what the error-classification check reads, so a body with one has an
 *   error path worth reporting on however short it is.
 */
function isTrivialView(view: TrivialityView): boolean {
  if (view.statementCount > MAX_STATEMENTS) return false;
  if (view.calleeNames.length > MAX_CALLS) return false;
  if (view.hasTryCatch) return false;
  if (view.initializerCallees.some((c) => c !== null)) return false;

  const callees = view.calleeNames.join(" ").toLowerCase();
  const hints = view.hintText.toLowerCase();
  return !SIDE_EFFECT_HINTS.some((h) => callees.includes(h) || hints.includes(h));
}

/** The rule over everything the entry point does, both exports and their same-file helpers. */
export function isTrivial(ep: EntryPoint): boolean {
  return isTrivialView({
    statementCount: ep.statementCount,
    calleeNames: ep.calleeNames,
    hasTryCatch: ep.hasTryCatch,
    initializerCallees: [ep.loaderInitializerCallee, ep.actionInitializerCallee],
    hintText: ep.source,
  });
}

/**
 * The same rule over ONE export's handlers.
 *
 * Needed because a per-export verdict judged against an entry-point-wide triviality rule accuses
 * the wrong half of a file. `auth.github.ts` and `auth.google.ts` are
 * `export let loader = () => redirect("/login")` beside an action that calls
 * `authenticator.authenticate`: per export the loader is unguarded, and the entry-point-wide rule
 * calls the file non-trivial because the ACTION is not, so `auth-boundary` accused a one-line
 * redirect stub of missing an auth guard. `checks/index.test.ts` pins both directions of that
 * ("reports not-applicable for a redirect-stub loader beside a guarded action" and "fails an export
 * whose own body does real work unguarded").
 */
export function isTrivialExport(e: RouteExport): boolean {
  return isTrivialView({
    statementCount: e.statementCount,
    calleeNames: e.calleeNames,
    hasTryCatch: e.hasTryCatch,
    initializerCallees: [e.initializerCallee],
    hintText: e.calleeTexts.join(" "),
  });
}
