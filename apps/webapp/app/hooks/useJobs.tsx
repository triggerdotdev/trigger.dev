import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam/route";
import { RouteMatch } from "@remix-run/react";
import { useTypedMatchesData } from "./useTypedMatchData";

export type ProjectJob = UseDataFunctionReturn<typeof loader>["projectJobs"][number];

export const jobsMatchId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam";

// This is only used in the JobsMenu component, which is the breadcrumb job list dropdown.
// This dropdown is only shown once you have selected a job, so we can assume that
// the route above has loaded and we can use the data from it.
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
