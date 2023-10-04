import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import type { loader as appLoader } from "~/routes/_app/route";
import { useChanged } from "./useChanged";
import { UIMatch } from "@remix-run/react";
import { useTypedMatchesData } from "./useTypedMatchData";
import { Handle } from "~/utils/handle";
import { AppData } from "~/utils/appData";

export type MatchedOrganization = UseDataFunctionReturn<typeof appLoader>["organizations"][number];

export function useOptionalOrganizations(matches?: AppData[]) {
  const data = useTypedMatchesData<typeof appLoader>({
    id: "routes/_app",
    matches,
  });
  return data?.organizations;
}

export function useOrganizations<T = AppData>(matches?: UIMatch<T, Handle>[]) {
  const orgs = useOptionalOrganizations(matches);
  invariant(orgs, "No organizations found in loader.");
  return orgs;
}

export function useOptionalOrganization(matches?: AppData[]) {
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

export function useOrganization<T = AppData>(matches?: UIMatch<T, Handle>[]) {
  const org = useOptionalOrganization(matches);
  invariant(org, "No organization found in loader.");
  return org;
}

export function useIsNewOrganizationPage<T = AppData>(matches?: UIMatch<T, Handle>[]): boolean {
  const data = useTypedMatchesData<any>({
    id: "routes/_app.orgs.new",
    matches,
  });
  return !!data;
}

export const useOrganizationChanged = (action: (org: MatchedOrganization | undefined) => void) => {
  useChanged(useOptionalOrganization, action);
};
