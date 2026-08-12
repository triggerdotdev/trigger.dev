import { type Path } from "@remix-run/react";
import { ENV_PAGE_TARGETS } from "./deeplinkPages";

export const PORTABLE_PAGE_PARAM = "page";

export const ENVIRONMENT_MATCH_ID =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam";

/** Pages below a section landing that name no resource, plus the built-in metric dashboards. */
const NESTED_PORTABLE_PAGES = [
  "alerts/new",
  "dashboards/llm",
  "dashboards/overview",
  "environment-variables/new",
  "models/compare",
  "schedules/new",
  "settings/general",
  "settings/integrations",
  "tasks/dashboard",
];

/** The branch lists render under any environment of their project, but not in every project. */
export const PROJECT_SPECIFIC_PAGES = ["branches", "dev-branches"];

/** Every page below an environment that names no resource, so any environment can render it. */
export const ENVIRONMENT_PORTABLE_PAGES: ReadonlySet<string> = new Set(
  [
    ...[...ENV_PAGE_TARGETS.values()].map((target) => target.landing),
    ...NESTED_PORTABLE_PAGES,
  ].filter((page) => page !== "")
);

/** The ones every project has, which is what a project or organization switch can carry. */
export const PROJECT_PORTABLE_PAGES: ReadonlySet<string> = new Set(
  [...ENVIRONMENT_PORTABLE_PAGES].filter((page) => !PROJECT_SPECIFIC_PAGES.includes(page))
);

/**
 * The nearest page above `suffix` in `pages`, as a path relative to the environment. A page named
 * after a resource truncates to its list page, and anything else — an unknown page, or a suffix
 * that is not a plain relative path — falls back to the environment root.
 */
function nearestPage(suffix: string, pages: ReadonlySet<string>): string {
  const segments = suffix.split("/");

  for (let depth = segments.length; depth > 0; depth--) {
    const candidate = segments.slice(0, depth).join("/");
    if (pages.has(candidate)) return candidate;
  }

  return "";
}

/** The page to keep when only the environment changes. */
export function environmentPortablePage(suffix: string): string {
  return nearestPage(suffix, ENVIRONMENT_PORTABLE_PAGES);
}

/** The page to keep when the project or organization changes. */
export function projectPortablePage(suffix: string): string {
  return nearestPage(suffix, PROJECT_PORTABLE_PAGES);
}

export function requestedPortablePage(request: Request): string {
  const requested = new URL(request.url).searchParams.get(PORTABLE_PAGE_PARAM);
  return projectPortablePage(requested ?? "");
}

export function portablePageSearch(page: string): string {
  return page === "" ? "" : `?${PORTABLE_PAGE_PARAM}=${page}`;
}

export function pagePath(environmentPath: string, page: string): string {
  return page === "" ? environmentPath : `${environmentPath}/${page}`;
}

export function pageBelowEnvironment(
  pathname: string,
  environmentPathname: string | undefined
): string {
  if (environmentPathname === undefined || !pathname.startsWith(environmentPathname)) return "";

  return pathname.slice(environmentPathname.length).replace(/^\/+/, "");
}

/** The current page in another environment of the same project, keeping filters where they apply. */
export function pathForEnvironmentSwitch({
  location,
  environmentPathname,
  environmentSlug,
}: {
  location: Path;
  environmentPathname: string | undefined;
  environmentSlug: string;
}): string {
  if (environmentPathname === undefined) {
    return fullPath({
      ...location,
      pathname: replaceEnvInPath(location.pathname, environmentSlug),
    });
  }

  const page = pageBelowEnvironment(location.pathname, environmentPathname);
  const portable = environmentPortablePage(page);
  const pathname = pagePath(replaceEnvInPath(environmentPathname, environmentSlug), portable);

  return portable === page ? fullPath({ ...location, pathname }) : pathname;
}

function replaceEnvInPath(path: string, environmentSlug: string) {
  return path.replace(/env\/([^/]+)/, `env/${environmentSlug}`);
}

function fullPath(location: Path) {
  return `${location.pathname}${location.search}${location.hash}`;
}
