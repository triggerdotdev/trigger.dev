import { type Path } from "@remix-run/react";
import { ENV_PAGE_TARGETS } from "./deeplinkPages";

const PORTABLE_PAGE_PARAM = "page";

export const ENVIRONMENT_MATCH_ID =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam";

/** Pages below a section landing that name no resource, plus the built-in metric dashboards. */
const NESTED_PORTABLE_PAGES = [
  "alerts/new",
  "dashboards/llm",
  "dashboards/overview",
  "dashboards/queues",
  "environment-variables/new",
  "models/compare",
  "schedules/new",
  "settings/general",
  "settings/integrations",
  "tasks/dashboard",
];

/** The branch lists render under any environment of their project, but not in every project. */
export const PROJECT_SPECIFIC_PAGES = ["branches", "dev-branches"];

/**
 * Gated on the organization — by a feature flag, or by the role the caller holds there — so their
 * loaders turn you away in an organization that answers differently.
 */
export const ORGANIZATION_SPECIFIC_PAGES = [
  "logs",
  "query",
  "dashboards/queues",
  "settings/integrations",
];

/**
 * Pages whose last segment is a name the user's code or the model catalog decides, rather than an
 * id one environment issued, so the same address names the same thing in every environment of the
 * project. Another project need not have that name, so only an environment switch carries it.
 */
export const SLUG_ADDRESSED_PAGES = [
  "agents",
  "models",
  "playground",
  "prompts",
  "tasks/scheduled",
  "tasks/standard",
  "test/tasks",
];

/**
 * Pages whose last segment is an id the organization issued rather than one environment, so the
 * same address names the same resource in every environment of the project. Another organization
 * never issued that id, so only an environment switch carries it.
 */
export const ORGANIZATION_ADDRESSED_PAGES = ["dashboards/custom"];

/** Every page below an environment that names no resource, so any environment can render it. */
export const ENVIRONMENT_PORTABLE_PAGES: ReadonlySet<string> = new Set(
  [
    ...[...ENV_PAGE_TARGETS.values()].map((target) => target.landing),
    ...NESTED_PORTABLE_PAGES,
  ].filter((page) => page !== "")
);

/** The ones every project has, which is what a project switch can carry. */
export const PROJECT_PORTABLE_PAGES: ReadonlySet<string> = new Set(
  [...ENVIRONMENT_PORTABLE_PAGES].filter((page) => !PROJECT_SPECIFIC_PAGES.includes(page))
);

/** The ones every organization has, which is what an organization switch can carry. */
export const ORGANIZATION_PORTABLE_PAGES: ReadonlySet<string> = new Set(
  [...PROJECT_PORTABLE_PAGES].filter((page) => !ORGANIZATION_SPECIFIC_PAGES.includes(page))
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

/**
 * `suffix` itself when its last segment names the same thing in every environment, as long as that
 * segment is a single plain one — a traversal or an encoded path in its place falls through to the
 * list page above it.
 */
function environmentNeutralPage(suffix: string): string | undefined {
  const boundary = suffix.lastIndexOf("/");
  if (boundary < 1) return undefined;

  const list = suffix.slice(0, boundary);
  if (!SLUG_ADDRESSED_PAGES.includes(list) && !ORGANIZATION_ADDRESSED_PAGES.includes(list)) {
    return undefined;
  }

  let slug: string;
  try {
    slug = decodeURIComponent(suffix.slice(boundary + 1));
  } catch {
    return undefined;
  }

  return slug !== "" && !/^\.+$/.test(slug) && !/[/\\]/.test(slug) ? suffix : undefined;
}

/** The page to keep when only the environment changes. */
export function environmentPortablePage(suffix: string): string {
  return environmentNeutralPage(suffix) ?? nearestPage(suffix, ENVIRONMENT_PORTABLE_PAGES);
}

/** The page to keep when the project changes. */
export function projectPortablePage(suffix: string): string {
  return nearestPage(suffix, PROJECT_PORTABLE_PAGES);
}

/** The page to keep when the organization changes. */
export function organizationPortablePage(suffix: string): string {
  return nearestPage(suffix, ORGANIZATION_PORTABLE_PAGES);
}

function requestedPage(request: Request): string {
  return new URL(request.url).searchParams.get(PORTABLE_PAGE_PARAM) ?? "";
}

export function requestedProjectPortablePage(request: Request): string {
  return projectPortablePage(requestedPage(request));
}

export function requestedOrganizationPortablePage(request: Request): string {
  return organizationPortablePage(requestedPage(request));
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

  const below = pathname.slice(environmentPathname.length);
  if (below !== "" && !below.startsWith("/")) return "";

  return below.replace(/^\/+/, "");
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
