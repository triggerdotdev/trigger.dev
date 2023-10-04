import { useMatches } from "@remix-run/react";
import { AppData } from "~/utils/appData";

export function useIsProjectChildPage(matches?: AppData[]) {
  if (!matches) {
    matches = useMatches();
  }

  return matches.some((matchData) => {
    return matchData.id.startsWith("routes/_app.orgs.$organizationSlug.projects.$projectParam");
  });
}
