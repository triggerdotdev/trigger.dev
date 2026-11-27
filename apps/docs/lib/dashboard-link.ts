// Every link into the dashboard goes through here. `/_/<page>` links land in the reader's own
// project: the dashboard resolves `_` to the project they last used, or the one named by
// `?project=<ref>` (the project the reader picked in the docs).
export const productionDashboardOrigin = "https://cloud.trigger.dev";

export const dashboardOrigin = process.env.NEXT_PUBLIC_DASHBOARD_URL || productionDashboardOrigin;

/** Signed-in docs: off unless this build sets it, so the default build is the anonymous docs. */
export const personalizationEnabled = process.env.NEXT_PUBLIC_DOCS_PERSONALIZATION === "1";

export function dashboardLink(path = "/", projectRef?: string | null): string {
  const url = new URL(path, dashboardOrigin);
  if (projectRef && url.pathname.startsWith("/_/")) url.searchParams.set("project", projectRef);
  return url.toString();
}

/** A dashboard URL written in the content (always the production origin), sent through dashboardLink. */
export function dashboardHref(href: string, projectRef?: string | null): string {
  if (!href.startsWith(productionDashboardOrigin)) return href;
  const url = new URL(href);
  return dashboardLink(`${url.pathname}${url.search}${url.hash}`, projectRef);
}

/** The dashboard login, returning to `docsUrl` afterwards. */
export function signInLink(docsUrl: string): string {
  return dashboardLink(`/resources/docs/signin?to=${encodeURIComponent(docsUrl)}`);
}
