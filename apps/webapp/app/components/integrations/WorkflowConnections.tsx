import classNames from "classnames";
import invariant from "tiny-invariant";
import type { ConnectionSlot } from "~/hooks/useConnectionSlots";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { List } from "../layout/List";
import { Header3 } from "../primitives/text/Headers";
import { SubTitle } from "../primitives/text/SubTitle";
import { ConnectionSelector } from "./ConnectionSelector";

export function WorkflowConnections({
  className,
  connectionSlots,
}: {
  className?: string;
  connectionSlots: ConnectionSlot[];
}) {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  return (
    <div className={classNames(className)}>
      <SubTitle>API Connections</SubTitle>
      <List>
        {connectionSlots.map((slot) => (
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
    </div>
  );
}
