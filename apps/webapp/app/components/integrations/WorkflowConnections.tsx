import invariant from "tiny-invariant";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { Panel } from "../layout/Panel";
import { Body } from "../primitives/text/Body";
import { Header3 } from "../primitives/text/Headers";
import { SubTitle } from "../primitives/text/SubTitle";
import { ConnectionSelector } from "./ConnectionSelector";

export function WorkflowConnections() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");
  const connectionSlots = useConnectionSlots();
  invariant(connectionSlots, "Connection slots not found");
  const allApisCount =
    connectionSlots.services.length + (connectionSlots.source ? 1 : 0);
  const connectedApisCount =
    connectionSlots.services.filter((c) => c.connection).length +
    (connectionSlots.source?.connection ? 1 : 0);
  const unconnectedApisCount = allApisCount - connectedApisCount ? 1 : 0;
  const unconnectedApisCountCopy = `, ${unconnectedApisCount} to connect`;

  return (
    <>
      <SubTitle>
        <>
          {connectedApisCount} API
          {connectedApisCount > 1
            ? "s"
            : connectedApisCount === 0
            ? "s"
            : ""}{" "}
          connected
          {unconnectedApisCount === 0 ? "" : unconnectedApisCountCopy}
        </>
      </SubTitle>
      <Panel className="mb-4 py-0">
        <div className="divide-y divide-slate-700">
          {connectionSlots.source && (
            <div className="flex gap-4 w-full py-3">
              <ApiLogoIcon
                integration={connectionSlots.source.integration}
                size="regular"
              />
              <div className="flex items-center justify-between gap-1 w-full">
                <Body>{connectionSlots.source.integration.name}</Body>
                <ConnectionSelector
                  type="source"
                  sourceServiceId={connectionSlots.source.id}
                  organizationId={organization.id}
                  integration={connectionSlots.source.integration}
                  connections={connectionSlots.source.possibleConnections}
                  selectedConnectionId={connectionSlots.source.connection?.id}
                  className="mr-1"
                  popoverAlign="right"
                />
              </div>
            </div>
          )}
          {connectionSlots.services.map((slot) => (
            <div key={slot.id} className="flex gap-4 items-center w-full py-3">
              <ApiLogoIcon integration={slot.integration} size="regular" />
              <div className="flex items-center justify-between w-full">
                <Header3 size="small" className="truncate text-slate-300">
                  {slot.integration?.name}
                </Header3>
                <ConnectionSelector
                  type="service"
                  sourceServiceId={slot.id}
                  organizationId={organization.id}
                  integration={slot.integration}
                  connections={slot.possibleConnections}
                  selectedConnectionId={slot.connection?.id}
                  className="mr-1"
                  popoverAlign="right"
                />
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
