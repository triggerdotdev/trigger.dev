import { type UIMatch } from "@remix-run/react";
import { type UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import { organizationMatchId } from "./useOrganizations";
import { useTypedMatchesData } from "./useTypedMatchData";

export type MatchedEnvironment = UseDataFunctionReturn<typeof orgLoader>["environment"];

export function useOptionalEnvironment(matches?: UIMatch[]) {
  const routeMatch = useTypedMatchesData<typeof orgLoader>({
    id: organizationMatchId,
    matches,
  });

  return routeMatch?.environment;
}

export function useEnvironment(matches?: UIMatch[]) {
  const environment = useOptionalEnvironment(matches);
  invariant(environment, "Environment must be defined");
  return environment;
}
