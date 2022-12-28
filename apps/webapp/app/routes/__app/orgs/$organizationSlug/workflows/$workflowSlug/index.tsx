import invariant from "tiny-invariant";
import { integrations } from "~/components/integrations/ConnectButton";
import { ConnectionSelector } from "~/components/integrations/ConnectionSelector";
import { Panel } from "~/components/layout/Panel";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

export default function Page() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");

  return (
    <>
      <Header1 className="mb-4">Overview</Header1>
      {connectionSlots.length > 0 && (
        <Panel>
          <Header2 size="small" className="mb-2">
            API integrations
          </Header2>
          <div className="flex flex-col gap-4 items-stretch w-full">
            {connectionSlots.map((slot) => (
              <div key={slot.id} className="flex flex-col gap-1">
                <Body>{slot.integration?.name}</Body>
                <ConnectionSelector
                  sourceId={slot.id}
                  organizationId={organization.id}
                  integration={integrations[0]}
                  connections={slot.possibleConnections}
                  selectedConnectionId={slot.connection?.id}
                />
              </div>
            ))}
          </div>
        </Panel>
      )}
      <div>Test functionality will go here</div>
    </>
  );
}
