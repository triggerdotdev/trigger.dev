import { Link } from "@remix-run/react";
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
        <li className="font-sm p-4 text-slate-400">
          You will be able to authenticate APIs on demand when your workflow
          runs. You can also{" "}
          <Link
            to="../integrations"
            className="text-slate-400 underline decoration-slate-500 underline-offset-4 transition hover:text-slate-100"
          >
            connect them now
          </Link>
          .
        </li>
      </List>
    </div>
  );
}
