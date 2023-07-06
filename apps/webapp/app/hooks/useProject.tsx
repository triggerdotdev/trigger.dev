import {
  UseDataFunctionReturn,
  useTypedRouteLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";
import { useChanged } from "./useChanged";

export type MatchedProject = UseDataFunctionReturn<typeof loader>["project"];

export type ProjectJob = MatchedProject["jobs"][number];

export function useOptionalProject() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam"
  );

  return routeMatch?.project;
}

export function useProject() {
  const project = useOptionalProject();
  invariant(project, "Project must be defined");
  return project;
}

export const useProjectChanged = (
  action: (org: MatchedProject | undefined) => void
) => {
  useChanged(useOptionalProject, action);
};
