import { DEV_ENVIRONMENT, LIVE_ENVIRONMENT } from "~/consts";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { useMatchesData } from "~/utils";

function isRuntimeEnvironment(
  environment: any
): environment is RuntimeEnvironment {
  return (
    environment &&
    typeof environment === "object" &&
    typeof environment.slug === "string"
  );
}

function isRuntimeEnvironments(
  environments: any
): environments is RuntimeEnvironment[] {
  return (
    environments &&
    typeof environments === "object" &&
    Array.isArray(environments) &&
    environments.every(isRuntimeEnvironment)
  );
}

export function useEnvironments(): RuntimeEnvironment[] | undefined {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");

  if (
    !routeMatch ||
    !isRuntimeEnvironments(routeMatch.data.organization.environments)
  ) {
    return undefined;
  }
  return routeMatch.data.organization.environments;
}

export function useDevEnvironment(): RuntimeEnvironment | undefined {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");

  if (
    !routeMatch ||
    !isRuntimeEnvironments(routeMatch.data.organization.environments)
  ) {
    return undefined;
  }
  return routeMatch.data.organization.environments.find(
    (environment: any) => environment.slug === DEV_ENVIRONMENT
  );
}

export function useLiveEnvironment(): RuntimeEnvironment | undefined {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");

  if (
    !routeMatch ||
    !isRuntimeEnvironments(routeMatch.data.organization.environments)
  ) {
    return undefined;
  }
  return routeMatch.data.organization.environments.find(
    (environment: any) => environment.slug === LIVE_ENVIRONMENT
  );
}
