import { type Path, useMatches } from "@remix-run/react";
import { type RuntimeEnvironment } from "@trigger.dev/database";
import { useOptimisticLocation } from "./useOptimisticLocation";

/**
 * It gives the URLs for the current page for other environments
 * @returns
 */
export function useEnvironmentSwitcher() {
  const matches = useMatches();
  const location = useOptimisticLocation();

  const urlForEnvironment = (newEnvironment: Pick<RuntimeEnvironment, "id" | "slug">) => {
    return routeForEnvironmentSwitch({
      location,
      matchId: matches[matches.length - 1].id,
      environmentSlug: newEnvironment.slug,
    });
  };

  return {
    urlForEnvironment,
  };
}

/** Function that takes in a UIMatch id, the current URL, the new environment slug, and returns a new URL  */
export function routeForEnvironmentSwitch({
  location,
  matchId,
  environmentSlug,
}: {
  location: Path;
  matchId: string;
  environmentSlug: string;
}) {
  switch (matchId) {
    // Run page
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam": {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentSlug).replace(
          /\/runs\/.*/,
          "/runs"
        ),
        search: "",
        hash: "",
      };
      return fullPath(newLocation);
    }
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments.$deploymentParam": {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentSlug).replace(
          /\/deployments\/.*/,
          "/deployments"
        ),
        search: "",
        hash: "",
      };
      return fullPath(newLocation);
    }
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam":
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.edit.$scheduleParam": {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentSlug).replace(
          /\/schedules\/.*/,
          "/schedules"
        ),
        search: "",
        hash: "",
      };
      return fullPath(newLocation);
    }
    default: {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentSlug),
        search: location.search,
        hash: location.hash,
      };
      return fullPath(newLocation);
    }
  }
}

/**
 * Replace the /env/<slug>/ in the path so it's /env/<environmentSlug>
 */
function replaceEnvInPath(path: string, environmentSlug: string) {
  //allow anything except /
  return path.replace(/env\/([^/]+)/, `env/${environmentSlug}`);
}

function fullPath(location: Path) {
  return `${location.pathname}${location.search}${location.hash}`;
}
