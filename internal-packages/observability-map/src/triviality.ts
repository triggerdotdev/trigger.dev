import type { RouteExport } from "./routeExports.js";
import type { EntryPoint } from "./types.js";

/**
 * Substrings that say the route touches a service, a datastore or the network. Always matched
 * against the callee names, and additionally against `TrivialityView.hintText`.
 */
const SIDE_EFFECT_HINTS = ["prisma", "logger", "fetch", "$transaction", "redis", "engine"];

/** Calls a genuinely trivial body makes. Three; a fourth admits
 * `_app.orgs.$organizationSlug.settings/route.tsx`, which awaits two service calls. */
const MAX_CALLS = 3;

/** Statements a genuinely trivial body has. Three; a fourth admits the routes that authenticate and
 * then hand off to a presenter, which have real work behind them. */
const MAX_STATEMENTS = 3;

/**
 * What the rule reads, so the entry-point-wide answer and a single export's answer are the same rule
 * over different bodies rather than two rules that can drift. Both limits, the reluctance and the
 * measured `hintText` decision: INTERNALS.md, "Triviality, in detail".
 */
type TrivialityView = {
  statementCount: number;
  calleeNames: string[];
  hasTryCatch: boolean;
  /** Every builder call in scope of this view. A view with one is never trivial. */
  initializerCallees: (string | null)[];
  /** Text to match the side-effect hints against besides the callee names: the whole file for the
   * entry-point-wide view, that export's own callee PATHS for a per-export one. Reading the file's
   * text into one export's verdict is defeatable by `log-caller-scope-userid`; emptying the term
   * instead switches five `auth-boundary` fixtures off. */
  hintText: string;
};

/**
 * Nothing to instrument: a body of a statement or two that only redirects, returns a fixed response,
 * or hands off in a single call. Checks report not-applicable for these rather than failing.
 *
 * Deliberately reluctant, because a route wrongly called trivial is exempted and never shows up in
 * the report again.
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
 * The same rule over ONE export's handlers. Needed because a per-export verdict judged against an
 * entry-point-wide rule accuses the wrong half of a file: `auth-boundary` accused
 * `auth.github.ts`'s one-line redirect loader of missing a guard because the ACTION is not trivial.
 * `checks/index.test.ts` pins both directions (`reports not-applicable for a redirect-stub loader
 * beside a guarded action`, `fails an export whose own body does real work unguarded`).
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
