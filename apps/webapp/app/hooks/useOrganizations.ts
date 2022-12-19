import type {
  getOrganizationFromSlug,
  Organization,
} from "~/models/organization.server";
import type { PrismaReturnType } from "~/utils";
import { hydrateObject, useMatchesData } from "~/utils";

export function useOrganizations(): Organization[] | undefined {
  const routeMatch = useMatchesData("routes/__app");

  if (!routeMatch || !routeMatch.data.organizations) {
    return undefined;
  }
  return hydrateObject<Organization[]>(routeMatch.data.organizations);
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
    PrismaReturnType<typeof getOrganizationFromSlug>
  >(routeMatch.data.organization);

  if (result == null) return undefined;
  return result;
}

export function useIsNewOrganizationPage(): boolean {
  const routeMatch = useMatchesData("routes/__app/orgs/new");
  return !!routeMatch;
}
