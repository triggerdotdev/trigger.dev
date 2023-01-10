import invariant from "tiny-invariant";
import { WorkflowConnections } from "~/components/integrations/WorkflowConnections";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";

export default function Page() {
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");

  const workflow = useCurrentWorkflow();
  invariant(workflow, "Workflow not found");

  return (
    <>
      <Title>Connected APIs</Title>
      {workflow.status !== "READY" && (
        <>
          <SubTitle>1 issue</SubTitle>
          <PanelWarning className="mb-6">
            This workflow requires its APIs to be connected before it can run.
          </PanelWarning>
        </>
      )}
      {connectionSlots.source || connectionSlots.services.length > 0 ? (
        <WorkflowConnections />
      ) : (
        <SubTitle>No API Integrations for this workflow</SubTitle>
      )}
    </>
  );
}
