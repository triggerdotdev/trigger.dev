import { useMatches } from "@remix-run/react";

export function useIsOrgChildPage() {
  const matchesData = useMatches();

  return matchesData.some((matchData) => {
    return (
      matchData.id.startsWith(
        "routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug"
      ) ||
      matchData.id.startsWith(
        "routes/__app/orgs/$organizationSlug/__org/projects/$projectP"
      )
    );
  });
}
