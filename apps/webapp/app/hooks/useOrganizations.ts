import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as appLoader } from "~/routes/__app";
import type { loader as orgLoader } from "~/routes/__app/orgs/$organizationSlug";
import { hydrateObject, useMatchesData } from "~/utils";

export function useOrganizations() {
  return (
    getOrganizationsFromMatchesData("routes/__app") ??
    getOrganizationsFromMatchesData("routes/__public")
  );
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

function getOrganizationsFromMatchesData(path: string) {
  const routeMatch = useMatchesData(path);

  if (!routeMatch || !routeMatch.data.organizations) {
    return undefined;
  }
  return hydrateObject<
    UseDataFunctionReturn<typeof appLoader>["organizations"]
  >(routeMatch.data.organizations);
}
