import invariant from "tiny-invariant";
import { WorkflowConnections } from "~/components/integrations/WorkflowConnections";
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
        <WorkflowConnections />
      ) : (
        <SubTitle>No API Integrations for this workflow</SubTitle>
      )}
    </>
  );
}
