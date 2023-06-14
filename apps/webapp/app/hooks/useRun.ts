import {
  UseDataFunctionReturn,
  useTypedRouteLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as runLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/route";
import { useOptionalProject } from "./useProject";

export type MatchedRun = UseDataFunctionReturn<typeof runLoader>["run"];

export function useOptionalRun() {
  const project = useOptionalProject();
  const routeMatch = useTypedRouteLoaderData<typeof runLoader>(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam"
  );

  if (!project || !routeMatch || !routeMatch.run) {
    return undefined;
  }

  if (routeMatch.run == null) {
    return undefined;
  }

  return routeMatch.run;
}

export function useRun() {
  const run = useOptionalRun();
  invariant(run, "Run must be present");
  return run;
}
