import invariant from "tiny-invariant";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { Body } from "../primitives/text/Body";
import { integrations } from "./ConnectButton";
import { ConnectionSelector } from "./ConnectionSelector";

export function WorkflowConnections() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");

  return (
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
  );
}
