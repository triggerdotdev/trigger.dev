import type { UseDataFunctionReturn } from "remix-typedjson";
import type { loader as runLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/route";
import { hydrateObject, useMatchesData } from "~/utils";
import { useOptionalProject } from "./useProject";
import invariant from "tiny-invariant";

export type MatchedRun = UseDataFunctionReturn<typeof runLoader>["run"];

export function useOptionalRun() {
  const project = useOptionalProject();
  const routeMatch = useMatchesData(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam"
  );

  if (!project || !routeMatch || !routeMatch.data.run) {
    return undefined;
  }

  if (routeMatch.data.run == null) {
    return undefined;
  }

  const run = hydrateObject<UseDataFunctionReturn<typeof runLoader>["run"]>(
    routeMatch.data.run
  );

  if (run == null) return undefined;

  return run;
}

export function useRun() {
  const run = useOptionalRun();
  invariant(run, "Run must be present");
  return run;
}
