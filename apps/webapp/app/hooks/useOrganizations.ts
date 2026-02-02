import { UIMatch } from "@remix-run/react";
import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import { useChanged } from "./useChanged";
import { useTypedMatchesData } from "./useTypedMatchData";

export type MatchedOrganization = UseDataFunctionReturn<typeof orgLoader>["organizations"][number];
export const organizationMatchId = "routes/_app.orgs.$organizationSlug";

export function useOptionalOrganizations(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
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

export function useIsImpersonating(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.isImpersonating === true;
}

export type CustomDashboard = UseDataFunctionReturn<typeof orgLoader>["customDashboards"][number];

export function useCustomDashboards(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.customDashboards ?? [];
}
