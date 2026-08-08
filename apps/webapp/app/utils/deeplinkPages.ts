export type DeeplinkTarget = {
  landing: string;
  prefix: string;
};

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
  ["webhooks", page("webhooks")],
]);

export const DEEPLINK_PATH_PREFIX = "/_";

export function deeplinkSuffix(pathname: string): string {
  const withSlash = `${DEEPLINK_PATH_PREFIX}/`;
  if (!pathname.startsWith(withSlash)) return "";

  return pathname.slice(withSlash.length);
}

//`.` and `..`, plain or escaped as `%2e%2e`, would climb out of the environment path.
function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === "..") return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }

  return decoded !== "." && decoded !== "..";
}

export function resolveDeeplinkPage(suffix: string): string | undefined {
  const segments = suffix.split("/").filter(isSafeSegment);
  const [first = "", ...rest] = segments;

  const target = ENV_PAGE_TARGETS.get(first.toLowerCase());
  if (target === undefined) return undefined;

  if (rest.length === 0) return target.landing;

  const prefixDepth = target.prefix.split("/").length;
  const writesPrefix = segments.slice(0, prefixDepth).join("/").toLowerCase() === target.prefix;
  const beyondPrefix = writesPrefix ? segments.slice(prefixDepth) : rest;

  return [target.prefix, ...beyondPrefix].join("/");
}
