import type { EntryPoint } from "./types.js";

/**
 * Substrings that say the route touches a service, a datastore or the network. Matched against the
 * callee names and the whole file, so an import of `prisma` disqualifies the file even when the
 * query itself sits somewhere the scanner does not walk.
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
 * Nothing to instrument: a body of a statement or two that only redirects, returns a fixed
 * response, or hands off in a single call. Checks report not-applicable for these rather than
 * failing, which is what stops `@.ts` being a finding.
 *
 * Deliberately reluctant. A route wrongly called trivial is exempted and never shows up in the
 * report again, so every signal that the body might be doing real work rules triviality out:
 *
 * - `statementCount` does not descend into inline callbacks, so a two-statement body can still hold
 *   a pile of work. `calleeNames` does descend, so the call count catches what the statement count
 *   misses.
 * - An initializer callee means the route is wrapped in a builder, and the config passed to that
 *   builder (`findResource`, `authorization`) is work the scanner never walks. The visible body is
 *   not the whole route, so we cannot claim it is trivial.
 * - A try/catch is exactly what the error-classification check reads, so a body with one has an
 *   error path worth reporting on however short it is.
 */
export function isTrivial(ep: EntryPoint): boolean {
  if (ep.statementCount > MAX_STATEMENTS) return false;
  if (ep.calleeNames.length > MAX_CALLS) return false;
  if (ep.hasTryCatch) return false;
  if (ep.loaderInitializerCallee !== null || ep.actionInitializerCallee !== null) return false;

  const callees = ep.calleeNames.join(" ").toLowerCase();
  const source = ep.source.toLowerCase();
  return !SIDE_EFFECT_HINTS.some((h) => callees.includes(h) || source.includes(h));
}
