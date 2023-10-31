import { UseDataFunctionReturn, useTypedRouteLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import type { loader as appLoader } from "~/routes/_app/route";
import { hydrateObject, useMatchesData } from "~/utils";
import { useChanged } from "./useChanged";
import { UIMatch } from "@remix-run/react";
import { useTypedMatchesData } from "./useTypedMatchData";

export type MatchedOrganization = UseDataFunctionReturn<typeof appLoader>["organizations"][number];

export function useOptionalOrganizations(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof appLoader>({
    id: "routes/_app",
    matches,
  });
  return data?.organizations;
}

export function useOrganizations(matches?: UIMatch[]) {
  const orgs = useOptionalOrganizations(matches);
  invariant(orgs, "No organizations found in loader.");
  return orgs;
}

export function useOptionalOrganization(matches?: UIMatch[]) {
  const orgs = useOptionalOrganizations(matches);
  const org = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });

  if (!orgs || !org || !org.organization) {
    return undefined;
  }

  return orgs.find((o) => o.id === org.organization.id);
}

export function useOrganization(matches?: UIMatch[]) {
  const org = useOptionalOrganization(matches);
  invariant(org, "No organization found in loader.");
  return org;
}

export function useIsNewOrganizationPage(matches?: UIMatch[]): boolean {
  const data = useTypedMatchesData<any>({
    id: "routes/_app.orgs.new",
    matches,
  });
  return !!data;
}

export const useOrganizationChanged = (action: (org: MatchedOrganization | undefined) => void) => {
  useChanged(useOptionalOrganization, action);
};
