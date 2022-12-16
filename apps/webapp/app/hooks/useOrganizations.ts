import type { Organization } from "~/models/organization.server";
import { hydrateObject, useMatchesData } from "~/utils";

export function useOrganizations(): Organization[] | undefined {
  const routeMatch = useMatchesData("routes/__app");

  if (!routeMatch || !routeMatch.data.organizations) {
    return undefined;
  }
  return hydrateObject<Organization[]>(routeMatch.data.organizations);
}

export function useCurrentOrganizationSlug(): string | undefined {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");
  return routeMatch?.params?.organizationSlug;
}

export function useCurrentOrganization(): Organization | undefined {
  const organizations = useOrganizations();
  const currentOrganizationSlug = useCurrentOrganizationSlug();

  const currentOrganization = organizations?.find(
    (org) => org.slug === currentOrganizationSlug
  );
  return currentOrganization;
}

export function useIsNewOrganizationPage(): boolean {
  const routeMatch = useMatchesData("routes/__app/orgs/new");
  return !!routeMatch;
}
