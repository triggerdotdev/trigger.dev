import type { UseDataFunctionReturn } from "remix-typedjson/dist/remix";
import type { Workflow } from "~/models/workflow.server";
import type { loader } from "~/routes/__app/orgs/$organizationSlug/workflows/$workflowSlug";
import { hydrateObject, useMatchesData } from "~/utils";

export function useWorkflows(): Workflow[] | undefined {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");
  if (!routeMatch || !routeMatch.data.organization.workflows) {
    return undefined;
  }

  const workflows = hydrateObject<Workflow[]>(
    routeMatch.data.organization.workflows
  );
  return workflows;
}

export function useCurrentWorkflow() {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/workflows/$workflowSlug"
  );

  if (!routeMatch || !routeMatch.data.workflow) {
    return undefined;
  }

  const result = hydrateObject<
    UseDataFunctionReturn<typeof loader>["workflow"]
  >(routeMatch.data.workflow);

  return result;
}
