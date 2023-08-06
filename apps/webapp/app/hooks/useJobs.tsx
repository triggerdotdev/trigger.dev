import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam/route";
import { RouteMatch } from "@remix-run/react";
import { useTypedMatchesData } from "./useTypedMatchData";

export type ProjectJob = UseDataFunctionReturn<typeof loader>["projectJobs"][number];

export const jobsMatchId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam";
export function useOptionalJobs(matches?: RouteMatch[]) {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: jobsMatchId,
    matches,
  });

  return routeMatch?.projectJobs;
}

export function useJobs(matches?: RouteMatch[]) {
  const jobs = useOptionalJobs(matches);
  invariant(jobs, "Jobs must be defined");
  return jobs;
}
