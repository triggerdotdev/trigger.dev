import type { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as projectLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";
import { hydrateObject, useMatchesData } from "~/utils";

export type MatchedProject = UseDataFunctionReturn<
  typeof projectLoader
>["project"];

export function useOptionalProject() {
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

export function useProject() {
  const project = useOptionalProject();
  invariant(project, "Project must be defined");
  return project;
}
