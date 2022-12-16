import type { Workflow } from "~/models/workflow.server";
import { useMatchesData } from "~/utils";

function isWorkflow(workflow: any): workflow is Workflow {
  return (
    workflow &&
    typeof workflow === "object" &&
    typeof workflow.title === "string"
  );
}

function isWorkflows(workflows: any): workflows is Workflow[] {
  return (
    workflows &&
    typeof workflows === "object" &&
    Array.isArray(workflows) &&
    workflows.every(isWorkflow)
  );
}

export function useWorkflows(): Workflow[] | undefined {
  const routeMatch = useMatchesData("routes/__app/orgs/$organizationSlug");

  if (!routeMatch || !isWorkflows(routeMatch.data.organization.workflows)) {
    return undefined;
  }
  return routeMatch.data.organization.workflows;
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
