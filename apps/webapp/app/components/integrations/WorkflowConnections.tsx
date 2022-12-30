import invariant from "tiny-invariant";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { Body } from "../primitives/text/Body";
import { ConnectionSelector } from "./ConnectionSelector";

export function WorkflowConnections() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");

  return (
    <div className="flex flex-col gap-4 items-stretch w-full">
      {connectionSlots.source && (
        <div className="flex flex-col gap-1">
          <Body>{connectionSlots.source.integration.name}</Body>
          <ConnectionSelector
            type="source"
            sourceServiceId={connectionSlots.source.id}
            organizationId={organization.id}
            integration={connectionSlots.source.integration}
            connections={connectionSlots.source.possibleConnections}
            selectedConnectionId={connectionSlots.source.connection?.id}
          />
        </div>
      )}
      {connectionSlots.services.map((slot) => (
        <div key={slot.id} className="flex flex-col gap-1">
          <Body>{slot.integration?.name}</Body>
          <ConnectionSelector
            type="service"
            sourceServiceId={slot.id}
            organizationId={organization.id}
            integration={slot.integration}
            connections={slot.possibleConnections}
            selectedConnectionId={slot.connection?.id}
          />
        </div>
      ))}
    </div>
  );
}
