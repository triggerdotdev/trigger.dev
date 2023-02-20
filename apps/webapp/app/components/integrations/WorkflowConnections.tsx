import classNames from "classnames";
import invariant from "tiny-invariant";
import { useConnectionSlots } from "~/hooks/useConnectionSlots";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { List } from "../layout/List";
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
      <List>
        {connectionSlots.source && (
          <li
            className={classNames(
              connectionSlots.source.connection === null
                ? "!border !border-rose-600 bg-rose-500/10"
                : "",
              "flex w-full items-center gap-4 px-4 py-4 first:rounded-t-md last:rounded-b-md"
            )}
          >
            <ApiLogoIcon
              integration={connectionSlots.source.integration}
              size="regular"
            />
            <div className="flex w-full items-center justify-between gap-1">
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
          </li>
        )}
        {connectionSlots.services.map((slot) => (
          <li
            key={slot.id}
            className={classNames(
              slot.connection === null
                ? "!border !border-rose-600 bg-rose-500/10"
                : "",
              "flex w-full items-center gap-4 px-4 py-4 first:rounded-t-md last:rounded-b-md"
            )}
          >
            <ApiLogoIcon integration={slot.integration} size="regular" />
            <div className="flex w-full items-center justify-between">
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
          </li>
        ))}
      </List>
    </>
  );
}
