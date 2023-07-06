import {
  UseDataFunctionReturn,
  useTypedRouteLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam/route";
import { useOptionalProject } from "./useProject";
import { useChanged } from "./useChanged";

export type MatchedJob = UseDataFunctionReturn<typeof loader>["job"];

export function useOptionalJob() {
  const project = useOptionalProject();
  const routeMatch = useTypedRouteLoaderData<typeof loader>(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam"
  );

  if (!project || !routeMatch || !routeMatch.job) {
    return undefined;
  }

  if (routeMatch.job == null) {
    return undefined;
  }

  //get the job from the list on the project
  return project.jobs.find((j) => j.id === routeMatch.job.id);
}

export function useJob() {
  const job = useOptionalJob();
  invariant(job, "Job must be defined");
  return job;
}

export const useJobChanged = (
  action: (org: MatchedJob | undefined) => void
) => {
  useChanged(useOptionalJob, action);
};
