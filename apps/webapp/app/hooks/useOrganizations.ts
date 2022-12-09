import type { Organization } from "~/models/organization.server";
import { useMatchesData } from "~/utils";

function isOrganization(org: any): org is Organization {
  return org && typeof org === "object" && typeof org.title === "string";
}

function isOrganizations(orgs: any): orgs is Organization[] {
  return (
    orgs &&
    typeof orgs === "object" &&
    Array.isArray(orgs) &&
    orgs.every(isOrganization)
  );
}

export function useOrganizations(): Organization[] | undefined {
  const routeMatch = useMatchesData("routes/__app");

  if (!routeMatch || !isOrganizations(routeMatch.data.organizations)) {
    return undefined;
  }
  return routeMatch.data.organizations;
}

export function useCurrentOrganizationSlug(): string | undefined {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");
  return routeMatch?.params?.organizationSlug;
}
