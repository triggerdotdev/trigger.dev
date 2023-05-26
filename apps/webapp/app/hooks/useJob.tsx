import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as jobLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam/route";
import { hydrateObject, useMatchesData } from "~/utils";
import { useProject } from "./useProject";

export type MatchedJob = UseDataFunctionReturn<typeof jobLoader>["job"];

export function useCurrentJob() {
  const project = useProject();
  const routeMatch = useMatchesData(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam"
  );

  if (!project || !routeMatch || !routeMatch.data.job) {
    return undefined;
  }

  if (routeMatch.data.job == null) {
    return undefined;
  }

  const result = hydrateObject<UseDataFunctionReturn<typeof jobLoader>["job"]>(
    routeMatch.data.job
  );

  if (result == null) return undefined;

  //get the job from the list on the project
  const job = project.jobs.find((j) => j.id === result.id);
  return job;
}
