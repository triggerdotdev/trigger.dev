/**
 * Where each /_/<name> goes, relative to the resolved environment.
 *
 * Two pieces, because a name's own page and the things underneath it are not always in the same
 * place. `landing` is used for a bare `/_/<name>`; `prefix` is what deeper segments hang off.
 * They differ only where a segment is not a page in its own right:
 *
 * - `tasks` has no bare route, and the task list is the environment root — but task detail pages do
 *   live under `/tasks`, so the landing is the root while the prefix stays `tasks`.
 * - `waitpoints` has no bare route either, and its only page and its detail pages are both under
 *   `/waitpoints/tokens`, so both are that.
 *
 * This mirrors the environment-layout routes
 * (`_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.*`): add a page here when one
 * is added there. `deeplinkPages.test.ts` checks every landing and every deep path against the
 * route files and fails if a page is missing or a target stops resolving.
 */
export type DeeplinkTarget = {
  /** Path for a bare `/_/<name>`. "" is the environment root. */
  landing: string;
  /** Deeper segments are appended to this: `/_/<name>/a/b` -> `<prefix>/a/b`. */
  prefix: string;
};

/** An ordinary page: its own segment is the page, and its children hang off it. */
function page(name: string): DeeplinkTarget {
  return { landing: name, prefix: name };
}

export const ENV_PAGE_TARGETS: ReadonlyMap<string, DeeplinkTarget> = new Map([
  ["agents", page("agents")],
  ["alerts", page("alerts")],
  ["apikeys", page("apikeys")],
  ["batches", page("batches")],
  ["branches", page("branches")],
  ["bulk-actions", page("bulk-actions")],
  ["concurrency", page("concurrency")],
  ["dashboards", page("dashboards")],
  ["deployments", page("deployments")],
  ["dev-branches", page("dev-branches")],
  ["environment-variables", page("environment-variables")],
  ["errors", page("errors")],
  ["limits", page("limits")],
  ["logs", page("logs")],
  ["models", page("models")],
  ["playground", page("playground")],
  ["prompts", page("prompts")],
  ["query", page("query")],
  ["queues", page("queues")],
  ["regions", page("regions")],
  ["runs", page("runs")],
  ["schedules", page("schedules")],
  ["sessions", page("sessions")],
  ["settings", page("settings")],
  ["tasks", { landing: "", prefix: "tasks" }],
  ["test", page("test")],
  ["waitpoints", { landing: "waitpoints/tokens", prefix: "waitpoints/tokens" }],
]);

/**
 * Where this route is mounted. Matches the `[_].$` route filename.
 *
 * The brackets are Remix's escape, and they are load-bearing rather than decorative: a flat-route
 * segment that starts with `_` is a pathless layout and contributes nothing to the URL, so a plain
 * `_.$` would mount this at `/*` and swallow the whole site. Escaping the underscore makes it a
 * literal segment — `createRoutePath` skips a segment only when the cooked *and* the raw spelling
 * both start with `_`, and the raw spelling here is `[_]`, so `[_].$` really does serve `/_/*`.
 */
export const DEEPLINK_PATH_PREFIX = "/_";

/**
 * The still-encoded suffix after /_, taken from the request's pathname rather than the splat param.
 * React Router decodes the splat, which turns an id containing an escaped slash
 * (`group%2Fmy-task`, as the dashboard's own link builder writes it) into two segments that match
 * no route. The pathname keeps `%2F` intact.
 *
 * Returns "" for anything that is not under the prefix. That includes a pathname the URL parser has
 * already rewritten: it normalises `%2e%2e` to `..` and resolves it, so a traversal attempt can
 * leave the prefix entirely before this ever sees it.
 *
 * The comparison is exact, unlike the page name's. React Router still matches the route
 * case-insensitively, but `_` has no case for it to differ in, so there is nothing to fold.
 * The remainder is returned as it was written, since the ids after the first segment are
 * case-sensitive.
 */
export function deeplinkSuffix(pathname: string): string {
  const withSlash = `${DEEPLINK_PATH_PREFIX}/`;
  if (!pathname.startsWith(withSlash)) return "";

  return pathname.slice(withSlash.length);
}

/** Segments that must not reach the target path, tested in the encoded form we receive. */
function isUsableSegment(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === "..") return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    //malformed escape, so it can't be part of a URL we build
    return false;
  }

  //`%2e%2e` and friends, which would otherwise climb out of the environment path
  return decoded !== "." && decoded !== "..";
}

/**
 * The path a deeplink suffix should redirect to, relative to the environment, or undefined when the
 * first segment names no page. Returns "" for a target that is the environment root itself.
 *
 * A bare name uses its landing path. Deeper segments are grafted onto the prefix, so
 * `/_/waitpoints/waitpoint_123` reaches the token that actually lives at
 * `/waitpoints/tokens/waitpoint_123`. A suffix that already spells out a path under the prefix is
 * kept as it was written, so both `/_/waitpoints/waitpoint_123` and the longhand
 * `/_/waitpoints/tokens/waitpoint_123` arrive at the same place.
 *
 * `suffix` is expected already encoded (see `deeplinkSuffix`) and is passed through untouched — an
 * `encodeURIComponent` pass here would double-encode every id that contains an escape.
 *
 * The name is matched case-insensitively because React Router's route matching is: it compiles
 * every path with the `i` flag unless the route opts into `caseSensitive`, so `/env/{env}/APIKeys`
 * would have matched its route, and `/_/APIKeys` should reach it rather than falling through to the
 * environment root. So is the written-out prefix, which is why the comparison is against the
 * lowercased path rather than the path itself — a prefix can be more than one segment
 * (`waitpoints/tokens`), and reading only `Tokens` as a segment of its own would graft the prefix
 * on top of it and produce `waitpoints/tokens/Tokens/{id}`.
 *
 * The prefix comes back in the map's own spelling and everything past it exactly as written, since
 * folding the case of a task or run id would break the link far more thoroughly than the miss this
 * fixes.
 */
export function resolveDeeplinkPage(suffix: string): string | undefined {
  const segments = suffix.split("/").filter(isUsableSegment);
  const [first = "", ...rest] = segments;

  const target = ENV_PAGE_TARGETS.get(first.toLowerCase());
  if (target === undefined) return undefined;

  if (rest.length === 0) return target.landing;

  //however many segments the prefix spans, so the whole of it is compared and none of it re-grafted
  const prefixDepth = target.prefix.split("/").length;
  const writesPrefix = segments.slice(0, prefixDepth).join("/").toLowerCase() === target.prefix;

  //already written out under the prefix, so grafting would duplicate it
  const beyondPrefix = writesPrefix ? segments.slice(prefixDepth) : rest;

  return [target.prefix, ...beyondPrefix].join("/");
}
