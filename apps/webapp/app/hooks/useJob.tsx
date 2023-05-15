import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as jobLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam/route";
import { hydrateObject, useMatchesData } from "~/utils";

export type MatchedJob = UseDataFunctionReturn<typeof jobLoader>["job"];

export function useCurrentJob() {
  const routeMatch = useMatchesData(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam"
  );

  if (!routeMatch || !routeMatch.data.job) {
    return undefined;
  }

  if (routeMatch.data.job == null) {
    return undefined;
  }

  const result = hydrateObject<UseDataFunctionReturn<typeof jobLoader>["job"]>(
    routeMatch.data.job
  );

  if (result == null) return undefined;
  return result;
}
