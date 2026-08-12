import { useMatches } from "@remix-run/react";
import { type RuntimeEnvironment } from "@trigger.dev/database";
import {
  ENVIRONMENT_MATCH_ID,
  pageBelowEnvironment,
  pathForEnvironmentSwitch,
  portablePage,
  portablePageSearch,
} from "~/utils/pageSwitching";
import {
  organizationPath,
  type OrgForPath,
  type ProjectForPath,
  v3ProjectPath,
} from "~/utils/pathBuilder";
import { useOptimisticLocation } from "./useOptimisticLocation";

/**
 * It gives the URLs for the current page for other environments
 * @returns
 */
export function useEnvironmentSwitcher() {
  const location = useOptimisticLocation();
  const environmentPathname = useEnvironmentPathname();

  const urlForEnvironment = (newEnvironment: Pick<RuntimeEnvironment, "id" | "slug">) => {
    return pathForEnvironmentSwitch({
      location,
      environmentPathname,
      environmentSlug: newEnvironment.slug,
    });
  };

  return {
    urlForEnvironment,
  };
}

/**
 * It gives the URLs for the current page in another project or organization. Which environment
 * that page opens in is left to the server, which picks the same one it would without a page.
 */
export function usePageSwitcher() {
  const location = useOptimisticLocation();
  const environmentPathname = useEnvironmentPathname();
  const page = portablePage(pageBelowEnvironment(location.pathname, environmentPathname));
  const search = portablePageSearch(page);

  return {
    urlForProject: (organization: OrgForPath, project: ProjectForPath) =>
      `${v3ProjectPath(organization, project)}${search}`,
    urlForOrganization: (organization: OrgForPath) => `${organizationPath(organization)}${search}`,
  };
}

function useEnvironmentPathname() {
  const matches = useMatches();
  return matches.find((match) => match.id === ENVIRONMENT_MATCH_ID)?.pathname;
}
