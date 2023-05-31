import { useMatches } from "@remix-run/react";

export function useIsProjectChildPage() {
  const matchesData = useMatches();

  return matchesData.some((matchData) => {
    return matchData.id.startsWith(
      "routes/_app.orgs.$organizationSlug.projects.$projectParam"
    );
  });
}
