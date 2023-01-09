import invariant from "tiny-invariant";
import { WorkflowConnections } from "~/components/integrations/WorkflowConnections";
import { Panel } from "~/components/layout/Panel";
import { Body } from "~/components/primitives/text/Body";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";

export default function Page() {
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");

  return (
    <>
      <Title>Connected APIs</Title>
      {connectionSlots.source || connectionSlots.services.length > 0 ? (
        <>
          <SubTitle>
            {connectionSlots.services.length} connected API
            {connectionSlots.services.length === 1 ? "" : "s"}
          </SubTitle>
          <Panel>
            <WorkflowConnections />
          </Panel>
        </>
      ) : (
        <Body>No API Integrations for this workflow</Body>
      )}
    </>
  );
}
