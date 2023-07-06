import { useEffect, useRef } from "react";
import {
  UseDataFunctionReturn,
  useTypedRouteLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import type { loader as appLoader } from "~/routes/_app/route";
import { hydrateObject, useMatchesData } from "~/utils";

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

export function useOrganizationChanged(
  action: (org: MatchedOrganization | undefined) => void
) {
  const previousOrganizationId = useRef<string | undefined>();
  const organization = useOptionalOrganization();

  useEffect(() => {
    if (previousOrganizationId.current !== organization?.id) {
      action(organization);
    }

    previousOrganizationId.current = organization?.id;
  }, [organization]);

  useEffect(() => {
    if (organization !== undefined) return;
    action(organization);
  }, []);
}

function useChanged<T extends { id: string }>(
  getItem: () => T | undefined,
  action: (item: T | undefined) => void
) {
  const previousItemId = useRef<string | undefined>();
  const item = getItem();

  useEffect(() => {
    if (previousItemId.current !== item?.id) {
      action(item);
    }

    previousItemId.current = item?.id;
  }, [item]);

  useEffect(() => {
    if (item !== undefined) return;
    action(item);
  }, []);
}
