import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as appLoader } from "~/routes/_app/route";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import { hydrateObject, useMatchesData } from "~/utils";
import invariant from "tiny-invariant";

export type MatchedOrganization = UseDataFunctionReturn<
  typeof appLoader
>["organizations"][number];

export function useOptionalOrganizations() {
  return useOrganizationsFromMatchesData(["routes/_app"]);
}

export function useOrganizations() {
  const orgs = useOptionalOrganizations();
  invariant(orgs, "No organizations found in loader.");
  return orgs;
}

export function useOrganization() {
  const routeMatch = useMatchesData("routes/_app.orgs.$organizationSlug");

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
  const routeMatch = useMatchesData("routes/_app.orgs.new");
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
