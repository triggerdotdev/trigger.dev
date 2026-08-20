import type { UIMatch } from "@remix-run/react";
import type { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import { useChanged } from "./useChanged";
import { useTypedMatchesData } from "./useTypedMatchData";

export type MatchedOrganization = UseDataFunctionReturn<typeof orgLoader>["organizations"][number];
export const organizationMatchId = "routes/_app.orgs.$organizationSlug";

function useOptionalOrganizations(matches?: UIMatch[]) {
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

export const useOrganizationChanged = (action: (org: MatchedOrganization | undefined) => void) => {
  const organization = useOptionalOrganization();
  useChanged(organization, action);
};

export function useIsImpersonating(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.isImpersonating === true;
}

export function useCustomDashboards(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.customDashboards ?? [];
}

export function useDashboardLimits(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.dashboardLimits ?? { used: 0, limit: 3 };
}

export function useWidgetLimitPerDashboard(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.widgetLimitPerDashboard ?? 16;
}

export function useBillingLimit(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.billingLimit;
}

export function useCanManageBillingLimits(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof orgLoader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.canManageBillingLimits === true;
}
