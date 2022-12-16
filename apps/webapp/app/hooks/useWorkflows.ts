import type { Workflow } from "~/models/workflow.server";
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

export function useCurrentWorkflowSlug(): string | undefined {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/workflows/$workflowSlug"
  );
  return routeMatch?.params?.workflowSlug;
}

export function useCurrentWorkflow(): Workflow | undefined {
  const workflows = useWorkflows();
  const currentWorkflowSlug = useCurrentWorkflowSlug();

  const currentWorkflow = workflows?.find(
    (org) => org.slug === currentWorkflowSlug
  );

  return currentWorkflow;
}
