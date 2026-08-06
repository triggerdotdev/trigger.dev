/**
 * Where each /deeplink/<name> lands, relative to the resolved environment. Most names are a page
 * in their own right and map to themselves. A few exist only as the parent of param routes
 * (`tasks.standard.$taskParam`, `waitpoints.tokens`) — a bare `/tasks` matches no route and would
 * 404 — so those map to the page a user actually wants instead.
 *
 * This mirrors the environment-layout routes
 * (`_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.*`): add a page here when one
 * is added there. `deeplinkPages.test.ts` checks every target against the route files and fails if
 * a page is missing or a target stops resolving.
 */
export const ENV_PAGE_TARGETS: ReadonlyMap<string, string> = new Map([
  ["agents", "agents"],
  ["alerts", "alerts"],
  ["apikeys", "apikeys"],
  ["batches", "batches"],
  ["branches", "branches"],
  ["bulk-actions", "bulk-actions"],
  ["concurrency", "concurrency"],
  ["dashboards", "dashboards"],
  ["deployments", "deployments"],
  ["dev-branches", "dev-branches"],
  ["environment-variables", "environment-variables"],
  ["errors", "errors"],
  ["limits", "limits"],
  ["logs", "logs"],
  ["models", "models"],
  ["playground", "playground"],
  ["prompts", "prompts"],
  ["query", "query"],
  ["queues", "queues"],
  ["regions", "regions"],
  ["runs", "runs"],
  ["schedules", "schedules"],
  ["sessions", "sessions"],
  ["settings", "settings"],
  // The environment root is the task list (its route is the env `_index`, titled "Tasks"), so a
  // bare /deeplink/tasks belongs there rather than at the secondary /tasks/dashboard view.
  ["tasks", ""],
  ["test", "test"],
  ["waitpoints", "waitpoints/tokens"],
]);

/**
 * The path a deeplink suffix should redirect to, relative to the environment, or undefined when the
 * first segment names no page. Returns "" for a target that is the environment root itself.
 *
 * Segments beyond the first are kept as given, because they address a real sub-route
 * (`/deeplink/runs/run_123`, `/deeplink/tasks/standard/my-task`); only a bare name uses the mapped
 * landing page. They arrive decoded, so they are re-encoded: a "?" or "#" in a segment must not
 * become the target's query or hash.
 */
export function resolveDeeplinkPage(splat: string): string | undefined {
  //traversal segments are dropped so a crafted suffix can't climb out of the environment path
  const segments = splat
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  const target = ENV_PAGE_TARGETS.get(segments[0] ?? "");
  if (target === undefined) return undefined;

  return segments.length > 1 ? segments.map(encodeURIComponent).join("/") : target;
}
