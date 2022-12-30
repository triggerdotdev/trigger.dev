import invariant from "tiny-invariant";
import { WorkflowConnections } from "~/components/integrations/WorkflowConnections";
import { Panel } from "~/components/layout/Panel";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";

export default function Page() {
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");

  return (
    <>
      <Header1 className="mb-4">Integrations</Header1>
      {connectionSlots.source || connectionSlots.services.length > 0 ? (
        <Panel>
          <Header2 size="small" className="mb-2">
            API integrations
          </Header2>
          <WorkflowConnections />
        </Panel>
      ) : (
        <Body>No API Integrations for this workflow</Body>
      )}
    </>
  );
}
