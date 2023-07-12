import { RouteMatch, useMatches } from "@remix-run/react";

export function useIsProjectChildPage(matches?: RouteMatch[]) {
  if (!matches) {
    matches = useMatches();
  }

  return matches.some((matchData) => {
    return matchData.id.startsWith(
      "routes/_app.orgs.$organizationSlug.projects.$projectParam"
    );
  });
}
