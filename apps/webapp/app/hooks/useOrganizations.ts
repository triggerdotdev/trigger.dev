import {
  UseDataFunctionReturn,
  useTypedRouteLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import type { loader as appLoader } from "~/routes/_app/route";
import { hydrateObject, useMatchesData } from "~/utils";
import { useChanged } from "./useChanged";

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

export function useOptionalOrganization() {
  const orgs = useOptionalOrganizations();
  const routeMatch = useTypedRouteLoaderData<typeof orgLoader>(
    "routes/_app.orgs.$organizationSlug"
  );

  if (!orgs || !routeMatch || !routeMatch.organization) {
    return undefined;
  }

  if (routeMatch.organization === null) {
    return undefined;
  }

  return orgs.find((o) => o.id === routeMatch.organization.id);
}

export function useOrganization() {
  const org = useOptionalOrganization();
  invariant(org, "No organization found in loader.");
  return org;
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

export const useOrganizationChanged = (
  action: (org: MatchedOrganization | undefined) => void
) => {
  useChanged(useOptionalOrganization, action);
};
