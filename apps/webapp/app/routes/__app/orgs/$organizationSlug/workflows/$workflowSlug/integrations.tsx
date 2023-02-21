import invariant from "tiny-invariant";
import { WorkflowConnections } from "~/components/integrations/WorkflowConnections";
import { PanelInfo } from "~/components/layout/PanelInfo";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { TertiaryLink } from "~/components/primitives/Buttons";
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
      {workflow.status === "CREATED" && (
        <>
          <PanelWarning
            message="This workflow requires its APIs to be connected before it can run."
            className="mb-6"
          />
        </>
      )}
      {workflow.status === "DISABLED" && (
        <PanelInfo
          message="This workflow is disabled. Runs cannot be triggered or tested while
        disabled. Runs in progress will continue until complete."
          className="mb-6"
        >
          <TertiaryLink to="settings" className="mr-1">
            Settings
          </TertiaryLink>
        </PanelInfo>
      )}
      {connectionSlots.source || connectionSlots.services.length > 0 ? (
        <WorkflowConnections
          connectionSlots={
            connectionSlots.source
              ? [connectionSlots.source, ...connectionSlots.services]
              : connectionSlots.services
          }
        />
      ) : (
        <SubTitle>No API Integrations for this workflow</SubTitle>
      )}
    </>
  );
}
