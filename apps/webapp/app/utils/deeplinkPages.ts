/**
 * Where each /deeplink/<name> goes, relative to the resolved environment.
 *
 * Two pieces, because a name's own page and the things underneath it are not always in the same
 * place. `landing` is used for a bare `/deeplink/<name>`; `prefix` is what deeper segments hang off.
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
  /** Path for a bare `/deeplink/<name>`. "" is the environment root. */
  landing: string;
  /** Deeper segments are appended to this: `/deeplink/<name>/a/b` -> `<prefix>/a/b`. */
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

/** Where this route is mounted. Matches the `deeplink.$` route filename. */
export const DEEPLINK_PATH_PREFIX = "/deeplink";

/**
 * The still-encoded suffix after /deeplink, taken from the request's pathname rather than the
 * splat param. React Router decodes the splat, which turns an id containing an escaped slash
 * (`group%2Fmy-task`, as the dashboard's own link builder writes it) into two segments that match
 * no route. The pathname keeps `%2F` intact.
 *
 * Returns "" for anything that is not under the prefix. That includes a pathname the URL parser has
 * already rewritten: it normalises `%2e%2e` to `..` and resolves it, so a traversal attempt can
 * leave the prefix entirely before this ever sees it.
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
 * `/deeplink/waitpoints/waitpoint_123` reaches the token that actually lives at
 * `/waitpoints/tokens/waitpoint_123`. A suffix that already spells out a path under the prefix is
 * kept as it was written, so both `/deeplink/waitpoints/waitpoint_123` and the longhand
 * `/deeplink/waitpoints/tokens/waitpoint_123` arrive at the same place.
 *
 * `suffix` is expected already encoded (see `deeplinkSuffix`) and is passed through untouched — an
 * `encodeURIComponent` pass here would double-encode every id that contains an escape.
 */
export function resolveDeeplinkPage(suffix: string): string | undefined {
  const segments = suffix.split("/").filter(isUsableSegment);

  const target = ENV_PAGE_TARGETS.get(segments[0] ?? "");
  if (target === undefined) return undefined;

  if (segments.length === 1) return target.landing;

  const written = segments.join("/");
  //already written out under the prefix, so grafting would duplicate it
  if (written === target.prefix || written.startsWith(`${target.prefix}/`)) return written;

  return [target.prefix, ...segments.slice(1)].join("/");
}
