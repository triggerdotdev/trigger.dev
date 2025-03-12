import { useMatch, useMatches, type Location } from "@remix-run/react";
import { type MinimumEnvironment } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { useEnvironment } from "./useEnvironment";
import { useEnvironments } from "./useEnvironments";
import { useOptimisticLocation } from "./useOptimisticLocation";

/**
 * It gives the URLs for the current page for other environments
 * @returns
 */
export function useEnvironmentSwitcher() {
  const environments = useEnvironments();
  const existingEnvironment = useEnvironment();
  const matches = useMatches();
  const location = useOptimisticLocation();

  console.log({
    environments,
    existingEnvironment,
    matches,
    location,
  });

  const urlForEnvironment = (newEnvironment: MinimumEnvironment) => {
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
  location: Location;
  matchId: string;
  environmentSlug: string;
}) {
  switch (matchId) {
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam": {
    }
    default: {
    }
  }

  //replace the /env/<slug>/ in the path so it's /env/<environmentSlug>
  const newPath = location.pathname.replace(/env\/([a-z0-9-]+)/, `env/${environmentSlug}`);

  console.log({
    oldPath: location.pathname,
    newPath,
  });

  return `${newPath}${location.search}${location.hash}`;
}
