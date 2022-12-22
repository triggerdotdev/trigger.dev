import invariant from "tiny-invariant";
import { integrations } from "~/components/integrations/ConnectButton";
import { ConnectionSelector } from "~/components/integrations/ConnectionSelector";
import { Panel } from "~/components/layout/Panel";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

export default function Page() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");
  console.log(connectionSlots);

  return (
    <>
      <Header1>Overview</Header1>
      <div>Pending API integrations panel will go here </div>
      <Panel>
        <Header2 size="small">API integrations</Header2>
        <div className="flex flex-col gap-1 items-stretch w-full">
          {connectionSlots.map((slot) => (
            <ConnectionSelector
              key={slot.id}
              slotId={slot.id}
              organizationId={organization.id}
              integration={integrations[0]}
              connections={slot.possibleConnections}
              selectedConnectionId={slot.connection?.id}
            />
          ))}
        </div>
      </Panel>
      <div>Test functionality will go here</div>
    </>
  );
}
