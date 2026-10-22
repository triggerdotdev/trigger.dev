// The org slug of a dashboard path like `/orgs/<slug>/...`, or undefined outside an org.
export function organizationSlugFromPath(path: string): string | undefined {
  const match = /^\/orgs\/([^/?#]+)/.exec(path);
  if (!match || match[1] === "new") {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}
