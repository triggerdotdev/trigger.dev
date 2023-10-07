import { UIMatch } from "@remix-run/react";
import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as runLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam/route";
import { useOptionalProject } from "./useProject";
import { useTypedMatchesData } from "./useTypedMatchData";
import { Handle } from "~/utils/handle";
import { AppData } from "~/utils/appData";

export type MatchedRun = UseDataFunctionReturn<typeof runLoader>["run"];

export function useOptionalRun(matches?: AppData[]) {
  const project = useOptionalProject(matches);
  const routeMatch = useTypedMatchesData<typeof runLoader>({
    id: "routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam.runs.$runParam",
    matches,
  });

  if (!project || !routeMatch || !routeMatch.run) {
    return undefined;
  }

  return routeMatch.run;
}

export function useRun(matches?: UIMatch<unknown, Handle>[]) {
  const run = useOptionalRun(matches);
  invariant(run, "Run must be present");
  return run;
}
