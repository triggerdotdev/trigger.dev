import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as projectLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";
import { hydrateObject, useMatchesData } from "~/utils";

export type MatchedProject = UseDataFunctionReturn<
  typeof projectLoader
>["project"];

export function useCurrentProject() {
  const routeMatch = useMatchesData(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam"
  );

  if (!routeMatch || !routeMatch.data.project) {
    return undefined;
  }

  if (routeMatch.data.project == null) {
    return undefined;
  }

  const result = hydrateObject<
    UseDataFunctionReturn<typeof projectLoader>["project"]
  >(routeMatch.data.project);

  if (result == null) return undefined;
  return result;
}

// export function useIsProjectImmediateChildPage() {
//   const location = useLocation();

//   location.

//   return matchesData.some((matchData) => {
//     return matchData.id.startsWith("routes/_app.orgs.$organizationSlug");
//   });
// }
