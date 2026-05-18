import { type UIMatch } from "@remix-run/react";
import { type UseDataFunctionReturn } from "remix-typedjson";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import { organizationMatchId } from "./useOrganizations";
import { useTypedMatchesData } from "./useTypedMatchData";

export type MatchedRegion = UseDataFunctionReturn<typeof orgLoader>["regions"][number];

export function useRegions(matches?: UIMatch[]): MatchedRegion[] {
  const routeMatch = useTypedMatchesData<typeof orgLoader>({
    id: organizationMatchId,
    matches,
  });

  return routeMatch?.regions ?? [];
}
