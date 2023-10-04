import { UIMatch } from "@remix-run/react";
import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";
import { useChanged } from "./useChanged";
import { useTypedMatchesData } from "./useTypedMatchData";
import { Handle } from "~/utils/handle";
import { AppData } from "~/utils/appData";

export type MatchedProject = UseDataFunctionReturn<typeof loader>["project"];

export const projectMatchId = "routes/_app.orgs.$organizationSlug.projects.$projectParam";

export function useOptionalProject(matches?: AppData) {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: projectMatchId,
    matches,
  });

  return routeMatch?.project;
}

export function useProject<T = AppData>(matches?: UIMatch<T, Handle>[]) {
  const project = useOptionalProject(matches);
  invariant(project, "Project must be defined");
  return project;
}

export const useProjectChanged = (action: (org: MatchedProject | undefined) => void) => {
  useChanged(useOptionalProject, action);
};
