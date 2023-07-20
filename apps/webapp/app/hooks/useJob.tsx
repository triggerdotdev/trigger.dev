import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam/route";
import { useChanged } from "./useChanged";
import { RouteMatch } from "@remix-run/react";
import { useTypedMatchesData } from "./useTypedMatchData";

export type MatchedJob = UseDataFunctionReturn<typeof loader>["job"];

export const jobMatchId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam";
export function useOptionalJob(matches?: RouteMatch[]) {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: jobMatchId,
    matches,
  });

  if (!routeMatch || !routeMatch.job) {
    return undefined;
  }

  return routeMatch.projectJobs.find((j) => j.id === routeMatch.job.id);
}

export function useJob(matches?: RouteMatch[]) {
  const job = useOptionalJob(matches);
  invariant(job, "Job must be defined");
  return job;
}

export const useJobChanged = (
  action: (org: MatchedJob | undefined) => void
) => {
  useChanged(useOptionalJob, action);
};
