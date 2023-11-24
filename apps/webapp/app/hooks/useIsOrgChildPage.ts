import { UIMatch, useMatches } from "@remix-run/react";

export function useIsOrgChildPage(matches?: UIMatch[]) {
  if (!matches) {
    matches = useMatches();
  }

  return matches.some((matchData) => {
    return matchData.id.startsWith("routes/_app.orgs.$organizationSlug");
  });
}
