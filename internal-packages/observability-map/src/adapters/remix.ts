export type Family =
  | "api.v1"
  | "api.other"
  | "webhooks"
  | "admin"
  | "resources"
  | "dashboard"
  | "ingest"
  | "other";

/**
 * The name that carries routing meaning for a given `fileName`. A directory route holds its module in
 * a fixed `route.ts`/`route.tsx`, so the segment before the slash is the meaningful name.
 */
function routeName(fileName: string): string {
  const slashIndex = fileName.indexOf("/");
  return slashIndex === -1 ? fileName : fileName.slice(0, slashIndex);
}

export function familyOf(fileName: string): Family {
  const name = routeName(fileName);
  // admin is checked first: admin.api.v1.* is an admin route, not an api.v1 one.
  if (name.startsWith("admin.")) return "admin";
  if (name.startsWith("api.v1.")) return "api.v1";
  if (name.startsWith("api.")) return "api.other";
  if (name.startsWith("webhooks.")) return "webhooks";
  if (name.startsWith("resources.")) return "resources";
  if (name.startsWith("_app.")) return "dashboard";
  if (name.startsWith("otel.") || name.startsWith("engine.")) return "ingest";
  return "other";
}

export function routePathOf(fileName: string): string {
  const withoutExt = routeName(fileName).replace(/\.(ts|tsx)$/, "");
  const segments = withoutExt
    .split(".")
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith("$") ? `:${s.slice(1)}` : s));
  return `/${segments.join("/")}`;
}
