import { useMatches } from "@remix-run/react";

export function useIsOrgChildPage() {
  const matchesData = useMatches();

  return matchesData.some((matchData) => {
    //todo refine this so it can be used to decide the nav collapsed state
    return matchData.id.startsWith("routes/_app.orgs.$organizationSlug");
  });
}
