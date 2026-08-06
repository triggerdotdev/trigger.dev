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
 * Only the caller's own segments are encoded — the prefix is our own literal. They arrive decoded,
 * so a "?" or "#" in a segment must not become the target's query or hash.
 */
export function resolveDeeplinkPage(splat: string): string | undefined {
  //traversal segments are dropped so a crafted suffix can't climb out of the environment path
  const segments = splat
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  const target = ENV_PAGE_TARGETS.get(segments[0] ?? "");
  if (target === undefined) return undefined;

  if (segments.length === 1) return target.landing;

  const encoded = segments.map(encodeURIComponent);
  const written = encoded.join("/");
  //already written out under the prefix, so grafting would duplicate it
  if (written === target.prefix || written.startsWith(`${target.prefix}/`)) return written;

  return [target.prefix, ...encoded.slice(1)].join("/");
}
