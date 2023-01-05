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
      <Header1 className="mb-4">Connected APIs</Header1>
      {connectionSlots.source || connectionSlots.services.length > 0 ? (
        <>
          <Header2 size="small" className="mb-2 text-slate-400">
            {connectionSlots.services.length} connected API
            {connectionSlots.services.length === 1 ? "" : "s"}
          </Header2>
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
