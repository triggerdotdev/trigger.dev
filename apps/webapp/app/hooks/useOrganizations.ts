import type { Organization } from ".prisma/client";
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
  const data = useMatchesData("routes/__app");

  if (!data || !isOrganizations(data.organizations)) {
    return undefined;
  }
  return data.organizations;
}
