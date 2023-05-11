import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as appLoader } from "~/routes/_app/route";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import { hydrateObject, useMatchesData } from "~/utils";

export type MatchedOrganization = UseDataFunctionReturn<
  typeof appLoader
>["organizations"][number];

export function useOrganizations() {
  return useOrganizationsFromMatchesData(["routes/__app", "routes/__public"]);
}

export function useCurrentOrganization() {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");

  if (!routeMatch || !routeMatch.data.organization) {
    return undefined;
  }

  if (routeMatch.data.organization == null) {
    return undefined;
  }

  const result = hydrateObject<
    UseDataFunctionReturn<typeof orgLoader>["organization"]
  >(routeMatch.data.organization);

  if (result == null) return undefined;
  return result;
}

export function useIsNewOrganizationPage(): boolean {
  const routeMatch = useMatchesData("routes/__app/orgs/new");
  return !!routeMatch;
}

function useOrganizationsFromMatchesData(paths: string[]) {
  const routeMatch = useMatchesData(paths);

  if (!routeMatch || !routeMatch.data.organizations) {
    return undefined;
  }
  return hydrateObject<
    UseDataFunctionReturn<typeof appLoader>["organizations"]
  >(routeMatch.data.organizations);
}
