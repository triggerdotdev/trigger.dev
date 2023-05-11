import type { UseDataFunctionReturn } from "remix-typedjson/dist/remix";
import type { loader as orgLoader } from "~/routes/_app.orgs.$organizationSlug/route";
import type { loader as workflowLoader } from "~/routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug";
import { hydrateObject, useMatchesData } from "~/utils";

export function useWorkflows() {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");
  if (!routeMatch || !routeMatch.data.organization.workflows) {
    return undefined;
  }

  const workflows = hydrateObject<
    UseDataFunctionReturn<typeof orgLoader>["organization"]["workflows"]
  >(routeMatch.data.organization.workflows);
  return workflows;
}

export type OrgWorkflow = NonNullable<ReturnType<typeof useWorkflows>>[number];

export function useCurrentWorkflow() {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug"
  );

  if (!routeMatch || !routeMatch.data.workflow) {
    return undefined;
  }

  const result = hydrateObject<
    UseDataFunctionReturn<typeof workflowLoader>["workflow"]
  >(routeMatch.data.workflow);

  return result;
}

export type CurrentWorkflow = ReturnType<typeof useCurrentWorkflow>;
export type CurrentWorkflowEventRule =
  NonNullable<CurrentWorkflow>["rules"][number];
