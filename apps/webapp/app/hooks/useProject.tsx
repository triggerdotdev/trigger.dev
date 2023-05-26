import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as projectLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";
import { hydrateObject, useMatchesData } from "~/utils";

export type MatchedProject = UseDataFunctionReturn<
  typeof projectLoader
>["project"];

export function useProject() {
  const routeMatch = useMatchesData(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam"
  );

  if (!routeMatch || !routeMatch.data.project) {
    return undefined;
  }

  const result = hydrateObject<
    UseDataFunctionReturn<typeof projectLoader>["project"]
  >(routeMatch.data.project);

  if (result == null) return undefined;
  return result;
}
